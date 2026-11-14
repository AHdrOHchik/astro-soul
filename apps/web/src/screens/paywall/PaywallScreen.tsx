import { Button, Notice, OptionCard, Screen, ScreenHeading, StarsIcon, StateView, VisuallyHidden, type ScreenProps } from '@astro-soul/ui';
import { useEffect, useId, useRef, useState } from 'react';
import type { Track } from '../../analytics';
import {
  failureCodeOf,
  isAbortError,
  isApiError,
  rejectionTextOf,
  resetAtOf,
  serverTextOf,
  type Api,
  type Invoice,
  type Me,
} from '../../api';
import { Reference } from '../../components/Reference';
import { Stars } from '../../components/Stars';
import { formatDay, formatMoment } from '../../i18n/format';
import { ru } from '../../i18n/ru';
import { expectedStars, grants, REPORT_PLAN, SUBSCRIPTION_PLANS, type PaywallPlan } from '../../lib/plans';
import { wait } from '../../lib/wait';
import type { InvoiceStatus, Telegram } from '../../telegram';
import styles from './PaywallScreen.module.css';

const copy = ru.paywall;

/**
 * How many times the server is asked whether the purchase arrived, by what Telegram said
 * when the invoice closed: twice after `paid`, three times after `pending` (payments.md §6).
 */
const CONFIRM_ATTEMPTS: Record<Extract<InvoiceStatus, 'paid' | 'pending'>, number> = { paid: 2, pending: 3 };
/** The pause between two such questions. */
export const CONFIRM_INTERVAL_MS = 2000;

export interface PaywallScreenProps {
  api: Pick<Api, 'createInvoice'>;
  telegram: Pick<Telegram, 'isTelegram' | 'canPay' | 'openInvoice'>;
  /** Who the user is, by the server's last word. What it grants is all the screen believes about a purchase. */
  me: Me;
  /**
   * Asks the server again. The answer also becomes the app's `me`, and the app counts the
   * payment as succeeded when that answer grants a plan Telegram called paid.
   */
  refreshMe: (signal?: AbortSignal) => Promise<Me>;
  /** The chart the full report is bought for; null when the report is not on offer here. */
  reportChartId: string | null;
  /** The plan chosen before the screen opened, e.g. by the button under the teaser. */
  initialPlan: PaywallPlan | null;
  /** The server refused to order a report and sent the user here: the screen says why it opened. */
  reportRequired?: boolean;
  /**
   * A plan Telegram called paid in this visit of the app and the server has not granted yet.
   * While there is one the screen sells nothing: a second payment for the same thing is the
   * one mistake a paywall can make with the user's money.
   */
  awaiting?: PaywallPlan | null;
  /** Telegram called the invoice of this plan paid, or about to be. The caller forgets it once the server grants the plan. */
  onAwaiting?: (plan: PaywallPlan) => void;
  track: Track;
  back?: ScreenProps['back'];
  onOpenTerms: () => void;
  /** The server confirmed that the report is paid for. */
  onReportPaid: () => void;
  /** On to the report. Absent when there is no chart to have a report about. */
  onOpenReport?: () => void;
  /** Leaves the paywall for where the user came from. */
  onClose: () => void;
}

/**
 * What the screen is busy with. `invoicing`: the server is making the invoice. `paying`:
 * Telegram is showing it. `confirming`: the server is asked whether the purchase arrived.
 * `processing`: it did not arrive in time.
 */
type Phase = 'choosing' | 'invoicing' | 'paying' | 'confirming' | 'processing';

/** What went wrong with the last attempt, said next to the button. A cancelled invoice is not one of these. */
type Problem =
  | { kind: 'unsupported' | 'outdated' | 'failed' }
  | { kind: 'rate_limited'; until: Date | undefined }
  | { kind: 'rejected'; text: string | undefined; requestId: string | undefined }
  | { kind: 'price_changed'; stars: number }
  | { kind: 'error'; text: string; requestId: string | undefined };

function problemOf(error: unknown): Problem {
  const requestId = isApiError(error) ? error.requestId : undefined;
  const code = isApiError(error) ? error.code : 'INTERNAL';
  if (code === 'RATE_LIMITED') return { kind: 'rate_limited', until: resetAtOf(error) };
  // Our bug or an outdated build, never the user's doing: the server's words, in either form it sends them.
  if (code === 'VALIDATION_FAILED') return { kind: 'rejected', text: rejectionTextOf(error), requestId };
  return { kind: 'error', text: serverTextOf(error) ?? ru.errors[code].text, requestId };
}

/**
 * Screen 7. Sells the full report (once, for one chart) and the subscriptions.
 *
 * The screen never decides that something was paid for. Telegram's «paid» only starts the
 * question to the server; what the server's `Me` grants is the answer.
 */
export function PaywallScreen({
  api,
  telegram,
  me,
  refreshMe,
  reportChartId,
  initialPlan,
  reportRequired = false,
  awaiting = null,
  onAwaiting,
  track,
  back,
  onOpenTerms,
  onReportPaid,
  onOpenReport,
  onClose,
}: PaywallScreenProps) {
  const titleId = useId();
  const groupName = useId();
  const subscribed = me.entitlements.is_active;
  // A subscription is not sold to a subscriber; the report is sold where there is a chart to buy it for.
  const report: PaywallPlan[] = reportChartId === null ? [] : [REPORT_PLAN];
  const offered: PaywallPlan[] = subscribed ? report : [...report, ...SUBSCRIPTION_PLANS];
  const [chosen, setChosen] = useState<PaywallPlan | null>(initialPlan);
  const plan = chosen !== null && offered.includes(chosen) ? chosen : null;
  // Opened while a payment is still on its way to the server: the screen starts where that payment left off.
  const [phase, setPhase] = useState<Phase>(awaiting === null ? 'choosing' : 'processing');
  const [problem, setProblem] = useState<Problem | null>(null);
  /** The plan whose purchase the server is being asked about. */
  const [awaited, setAwaited] = useState<PaywallPlan | null>(awaiting);
  // The invoices made on this screen. From the moment there is one, its price is the price, and a second tap opens it again.
  const [invoices, setInvoices] = useState<Partial<Record<PaywallPlan, Invoice>>>({});
  const priceOf = (code: PaywallPlan) => invoices[code]?.stars ?? expectedStars(code);

  // Ends everything the screen started when it is left.
  const life = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    life.current = controller;
    return () => {
      controller.abort();
    };
  }, []);

  /** Asks the server whether the purchase arrived, `attempts` times at most. */
  const confirm = async (bought: PaywallPlan, attempts: number, signal: AbortSignal) => {
    setAwaited(bought);
    setPhase('confirming');
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      let fresh: Me | null = null;
      try {
        if (attempt > 0) await wait(CONFIRM_INTERVAL_MS, signal);
        fresh = await refreshMe(signal);
      } catch (error) {
        if (signal.aborted || isAbortError(error)) return;
        // A question that got no answer is a question that confirmed nothing.
      }
      if (signal.aborted) return;
      if (fresh !== null && grants(fresh, bought)) {
        // Counted by the app, where the server's answer lands: a payment confirmed from another screen counts the same.
        if (bought === REPORT_PLAN) onReportPaid();
        else setPhase('choosing');
        return;
      }
    }
    setPhase('processing');
  };

  const pay = async () => {
    const signal = life.current?.signal;
    if (plan === null || phase !== 'choosing' || signal === undefined) return;
    setProblem(null);
    if (!telegram.canPay) {
      // Nothing here can open an invoice, so none is asked for.
      console.warn('[paywall] A Stars invoice opens only inside Telegram, version 6.1 or newer.');
      setProblem({ kind: telegram.isTelegram ? 'outdated' : 'unsupported' });
      return;
    }
    track('checkout_started', { plan_code: plan });

    let invoice = invoices[plan];
    if (invoice === undefined) {
      setPhase('invoicing');
      try {
        // The report is bought for one chart, named here: the server does not guess which.
        const forChart = plan === REPORT_PLAN && reportChartId !== null ? { chart_id: reportChartId } : {};
        invoice = await api.createInvoice({ plan_code: plan, ...forChart }, signal);
      } catch (error) {
        if (signal.aborted || isAbortError(error)) return;
        setPhase('choosing');
        setProblem(problemOf(error));
        track('error_shown', { screen: 'paywall', code: failureCodeOf(error) });
        return;
      }
      if (signal.aborted) return;
      const made = invoice;
      setInvoices((current) => ({ ...current, [plan]: made }));
      if (made.stars !== expectedStars(plan)) {
        // Not the price the list named. The user sees the server's one before anything is opened.
        setPhase('choosing');
        setProblem({ kind: 'price_changed', stars: made.stars });
        return;
      }
    }

    setPhase('paying');
    track('checkout_opened', { plan_code: plan });
    const outcome = await telegram.openInvoice(invoice.invoice_link);
    const maybePaid = outcome === 'paid' || outcome === 'pending';
    // Said before anything else, and even if the screen is gone by now: from here on the app must not offer to pay for this again.
    if (maybePaid) onAwaiting?.(plan);
    if (signal.aborted) {
      // The screen was left while the invoice was open. The server is still asked: the rest of the app shows what it grants.
      if (maybePaid) void refreshMe().catch(() => undefined);
      return;
    }
    switch (outcome) {
      case 'cancelled':
        // The user changed their mind. Not a failure: nothing to say about it.
        track('payment_cancelled', { plan_code: plan });
        setPhase('choosing');
        return;
      case 'failed':
        track('error_shown', { screen: 'paywall', code: 'payment_failed' });
        setProblem({ kind: 'failed' });
        setPhase('choosing');
        return;
      case 'unsupported':
        // The client would not show the invoice after all.
        setProblem({ kind: telegram.isTelegram ? 'outdated' : 'unsupported' });
        setPhase('choosing');
        return;
      default:
        // Telegram's word that the invoice is paid, or about to be. It only tells when to ask the server.
        setInvoices((current) => ({ ...current, [plan]: undefined }));
        await confirm(plan, CONFIRM_ATTEMPTS[outcome], signal);
    }
  };

  if (phase === 'confirming') {
    return (
      <Screen busy>
        <StateView icon={<StarsIcon />} title={copy.confirmingTitle} text={copy.confirmingText} />
      </Screen>
    );
  }
  if (phase === 'processing') {
    return (
      <Screen back={back}>
        <StateView icon={<StarsIcon />} title={copy.processingTitle} text={copy.processingText}>
          <Button
            onClick={() => {
              const signal = life.current?.signal;
              if (awaited !== null && signal !== undefined) void confirm(awaited, 1, signal);
            }}
          >
            {copy.checkAgain}
          </Button>
          <Button variant="secondary" onClick={onClose}>
            {copy.leave}
          </Button>
        </StateView>
      </Screen>
    );
  }

  const until = me.subscription.expires_at === null ? '' : formatDay(me.subscription.expires_at);
  const activeLine = until === '' ? copy.active : copy.activeUntil(until);
  if (offered.length === 0) {
    // Nothing to sell: the subscription is active and there is no report to buy here.
    return (
      <Screen back={back}>
        <StateView icon={<StarsIcon />} title={activeLine}>
          {onOpenReport ? (
            <Button onClick={onOpenReport}>{ru.chart.openReport}</Button>
          ) : (
            <Button onClick={onClose}>{copy.leave}</Button>
          )}
        </StateView>
      </Screen>
    );
  }

  const busy = phase !== 'choosing';
  const offersReport = offered.includes(REPORT_PLAN);
  return (
    <Screen
      labelledBy={titleId}
      back={back}
      busy={busy}
      footer={
        <>
          {problem && <ProblemNote problem={problem} />}
          <Button
            disabled={plan === null || busy}
            onClick={() => {
              void pay();
            }}
          >
            <PayLabel phase={phase} price={plan === null ? null : priceOf(plan)} />
          </Button>
        </>
      }
    >
      <div className={styles.content}>
        <ScreenHeading id={titleId} title={copy.title} text={copy.lead} focusOnMount />
        {reportRequired && offersReport && (
          <Notice>
            {copy.reportRequired} <Stars count={priceOf(REPORT_PLAN)} />
          </Notice>
        )}
        {subscribed && <Notice>{activeLine}</Notice>}
        <fieldset className={styles.options} disabled={busy}>
          <legend>
            <VisuallyHidden>{copy.optionsLabel}</VisuallyHidden>
          </legend>
          {offered.map((code) => (
            <OptionCard
              key={code}
              name={groupName}
              value={code}
              checked={plan === code}
              onSelect={(value) => {
                setChosen(value);
                // What went wrong was about the plan chosen before.
                setProblem(null);
              }}
              title={copy.plans[code].title}
              description={copy.plans[code].description}
              aside={<Stars count={priceOf(code)} />}
            />
          ))}
        </fieldset>
        {offersReport && !subscribed && <p className={styles.note}>{copy.reportIsSeparate}</p>}
        {plan !== null && plan !== REPORT_PLAN && <p className={styles.note}>{copy.renewal}</p>}
        <Button variant="ghost" onClick={onOpenTerms}>
          {copy.terms}
        </Button>
      </div>
    </Screen>
  );
}

function PayLabel({ phase, price }: { phase: Phase; price: number | null }) {
  if (phase === 'invoicing') return <>{copy.creating}</>;
  if (phase === 'paying') return <>{copy.paying}</>;
  if (price === null) return <>{copy.choose}</>;
  return (
    <span>
      {copy.pay} <Stars count={price} />
    </span>
  );
}

function ProblemNote({ problem }: { problem: Problem }) {
  const requestId = 'requestId' in problem ? problem.requestId : undefined;
  return (
    <div className={styles.problem} role="alert">
      <Notice tone="warning">
        <ProblemText problem={problem} />
      </Notice>
      {requestId && <Reference value={requestId} label={ru.common.requestId(requestId)} />}
    </div>
  );
}

function ProblemText({ problem }: { problem: Problem }) {
  switch (problem.kind) {
    case 'unsupported':
      return <>{copy.unsupported}</>;
    case 'outdated':
      return <>{copy.outdated}</>;
    case 'failed':
      return <>{copy.failed}</>;
    case 'rate_limited':
      return <>{problem.until ? `${copy.rateLimited} ${copy.rateLimitedUntil(formatMoment(problem.until))}` : copy.rateLimited}</>;
    case 'rejected':
      return <>{problem.text ? `${copy.invoiceRejected} ${problem.text}` : copy.invoiceRejected}</>;
    case 'price_changed':
      return (
        <>
          {copy.priceChanged} <Stars count={problem.stars} />. {copy.priceChangedAction}
        </>
      );
    default:
      return <>{problem.text}</>;
  }
}
