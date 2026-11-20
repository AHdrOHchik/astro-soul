import { Button, Notice, OptionCard, Screen, ScreenHeading, Skeleton, SkeletonGroup, StarsIcon, StateView, VisuallyHidden, type ScreenProps } from '@astro-soul/ui';
import { useEffect, useId, useRef, useState } from 'react';
import type { Track } from '../../analytics';
import {
  failureCodeOf,
  fieldErrorsOf,
  isAbortError,
  isApiError,
  rejectionTextOf,
  resetAtOf,
  serverTextOf,
  type Api,
  type CompatibilityList,
  type Invoice,
  type Me,
  type OrderablePlanCode,
  type PlanKind,
  type PlanOffer,
} from '../../api';
import { Reference } from '../../components/Reference';
import { Stars } from '../../components/Stars';
import { formatDay, formatMoment } from '../../i18n/format';
import { ru } from '../../i18n/ru';
import { copy30 } from '../../i18n/round30';
import { grants, REPORT_PLAN } from '../../lib/plans';
import { wait } from '../../lib/wait';
import type { InvoiceStatus, Telegram } from '../../telegram';
import styles from './PaywallScreen.module.css';

const copy = ru.paywall;
const isReportOffer = (offer: PlanOffer): boolean => offer.plan_code === REPORT_PLAN || (offer.test && offer.kind === 'one_off');

/**
 * How many times the server is asked whether the purchase arrived, by what Telegram said
 * when the invoice closed: twice after `paid`, three times after `pending` (payments.md §6).
 */
const CONFIRM_ATTEMPTS: Record<Extract<InvoiceStatus, 'paid' | 'pending'>, number> = { paid: 2, pending: 3 };
/** The pause between two such questions. */
export const CONFIRM_INTERVAL_MS = 2000;

export interface PaywallScreenProps {
  api: Pick<Api, 'getPlans' | 'createInvoice'>;
  telegram: Pick<Telegram, 'isTelegram' | 'canPay' | 'openInvoice'>;
  /** Who the user is, by the server's last word. What it grants is all the screen believes about a purchase. */
  me: Me;
  /**
   * Asks the server again. The answer also becomes the app's `me`, and the app counts the
   * payment as succeeded when that answer grants a plan Telegram called paid.
   */
  refreshMe: (signal?: AbortSignal) => Promise<Me>;
  /** The chart a report purchase is associated with when there is one. */
  reportChartId: string | null;
  /** Whether this paywall was opened from a full-report flow. */
  offersReport: boolean;
  /** Prefer this kind from the live catalogue, e.g. a one-off plan opened from the report teaser. */
  initialKind: PlanKind | null;
  /**
   * Whether this build sells subscriptions (`VITE_SUBSCRIPTIONS`); it does not unless told to.
   * Without `true` the screen sells the full report alone: the plans are not in the list, and
   * nothing on the screen speaks of a subscription the user could buy.
   */
  subscriptions?: boolean;
  /** The server refused to order a report and sent the user here: the screen says why it opened. */
  reportRequired?: boolean;
  compatibilityPurchase?: boolean;
  refreshCompatibility?: (signal?: AbortSignal) => Promise<CompatibilityList>;
  onCompatibilityPaid?: () => void;
  /**
   * A plan Telegram called paid in this visit of the app and the server has not granted yet.
   * While there is one the screen sells nothing: a second payment for the same thing is the
   * one mistake a paywall can make with the user's money.
   */
  awaiting?: { planCode: OrderablePlanCode; kind: PlanKind; report: boolean } | null;
  /**
   * The chart of that purchase when it is the report: the server confirms a report for the
   * chart it was bought for, and that need not be the chart this screen sells one for.
   * Left out, it is this screen's own chart.
   */
  awaitingChartId?: string | null;
  /** Telegram called the invoice paid, or about to be; retain only its server-supplied code and kind. */
  onAwaiting?: (plan: PlanOffer, report: boolean) => void;
  track: Track;
  back?: ScreenProps['back'];
  onOpenTerms: () => void;
  /** The server confirmed that the report is paid for. */
  onReportPaid: () => void;
  /** On to the report. Absent when there is no chart to have a report about. */
  onOpenReport?: () => void;
  /** Leaves the paywall for where the user came from. */
  onClose: () => void;
  /** Starts the clean onboarding when a newly confirmed subscription survives without its deleted chart. */
  onBuildChart?: () => void;
  /**
   * The server refused the invoice because the chart the report is for is not the user's
   * (`chart_id` among the rejected fields): it went with the user's data. The caller leads
   * on from there; without this prop the refusal is shown like any other.
   */
  onChartGone?: () => void;
}

/**
 * What the screen is busy with. `invoicing`: the server is making the invoice. `paying`:
 * Telegram is showing it. `confirming`: the server is asked whether the purchase arrived.
 * `processing`: it did not arrive in time.
 */
type Phase = 'choosing' | 'invoicing' | 'paying' | 'confirming' | 'processing';
type PlansRequest =
  | { status: 'loading' }
  | { status: 'ready'; plans: PlanOffer[] }
  | { status: 'error'; unauthorized: boolean };

/** What went wrong with the last attempt, said next to the button. A cancelled invoice is not one of these. */
type Problem =
  | { kind: 'unsupported' | 'outdated' | 'failed' }
  | { kind: 'rate_limited'; until: Date | undefined }
  | { kind: 'rejected'; text: string | undefined; requestId: string | undefined }
  | { kind: 'price_changed' }
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
function displayablePlans(
  plans: PlanOffer[],
  options: { subscriptions: boolean; subscribed: boolean; offersReport: boolean; hasChart: boolean; compatibilityPurchase?: boolean },
): PlanOffer[] {
  return plans.filter((offer) => {
    if (options.compatibilityPurchase) return offer.plan_code === 'compat_249' && !offer.test;
    if (offer.kind === 'subscription' && (!options.subscriptions || options.subscribed)) return false;
    if (offer.test && offer.kind === 'one_off' && !options.hasChart) return false;
    if (!offer.test && offer.kind === 'one_off' && !options.offersReport) return false;
    return true;
  });
}

export function PaywallScreen({
  api,
  telegram,
  me,
  refreshMe,
  reportChartId,
  offersReport,
  initialKind,
  subscriptions = false,
  reportRequired = false,
  compatibilityPurchase = false,
  refreshCompatibility,
  onCompatibilityPaid,
  awaiting = null,
  awaitingChartId = null,
  onAwaiting,
  track,
  back,
  onOpenTerms,
  onReportPaid,
  onOpenReport,
  onClose,
  onBuildChart,
  onChartGone,
}: PaywallScreenProps) {
  const titleId = useId();
  const groupName = useId();
  const subscribed = me.entitlements.is_active;
  const [plansRequest, setPlansRequest] = useState<PlansRequest>({ status: 'loading' });
  const [reloadPlans, setReloadPlans] = useState(0);
  const [chosen, setChosen] = useState<OrderablePlanCode | null>(null);
  const visiblePlans = displayablePlans(plansRequest.status === 'ready' ? plansRequest.plans : [], {
    subscriptions,
    subscribed,
    offersReport,
    hasChart: reportChartId !== null,
    compatibilityPurchase,
  });
  const offered = visiblePlans.filter((offer) => !offer.test);
  const testOffered = visiblePlans.filter((offer) => offer.test);
  const plan = chosen === null ? null : visiblePlans.find((offer) => offer.plan_code === chosen) ?? null;
  const expectedPlanMissing = plansRequest.status === 'ready' && (
    compatibilityPurchase
      ? !plansRequest.plans.some((offer) => offer.plan_code === 'compat_249' && !offer.test)
      : offersReport
        ? !plansRequest.plans.some((offer) => offer.plan_code === REPORT_PLAN && !offer.test)
        : initialKind === 'subscription' && subscriptions && !subscribed && !plansRequest.plans.some((offer) => offer.kind === 'subscription' && !offer.test)
  );
  // Opened while a payment is still on its way to the server: the screen starts where that payment left off.
  const [phase, setPhase] = useState<Phase>(awaiting === null ? 'choosing' : 'processing');
  const [problem, setProblem] = useState<Problem | null>(null);
  // Only a subscription just confirmed by the server, with no chart in that same Me, gets the recovery message.
  const [subscriptionSuccessWithoutChart, setSubscriptionSuccessWithoutChart] = useState<Me | null>(null);
  /** The purchase the server is being asked about: its catalogue kind and associated chart, if any. */
  const [awaited, setAwaited] = useState<{ planCode: OrderablePlanCode; kind: PlanKind; report: boolean; chartId: string | null } | null>(
    awaiting === null
      ? null
      : { planCode: awaiting.planCode, kind: awaiting.kind, report: awaiting.report, chartId: awaitingChartId ?? (awaiting.report ? reportChartId : null) },
  );
  // Invoices stay in memory only for this screen, to reopen the same invoice after the user reviews a changed server price.
  const [invoices, setInvoices] = useState<Partial<Record<OrderablePlanCode, Invoice>>>({});
  const priceOf = (offer: PlanOffer) => invoices[offer.plan_code]?.stars ?? offer.stars;

  // Ends everything the screen started when it is left.
  const life = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    life.current = controller;
    return () => {
      controller.abort();
    };
  }, []);

  // A fresh authenticated, no-store catalogue is requested every time this screen mounts.
  useEffect(() => {
    const controller = new AbortController();
    void api
      .getPlans(controller.signal)
      .then((plans) => {
        if (controller.signal.aborted) return;
        const available = displayablePlans(plans, {
          subscriptions,
          subscribed,
          offersReport,
          hasChart: reportChartId !== null,
          compatibilityPurchase,
        });
        setPlansRequest({ status: 'ready', plans });
        setChosen((current) => {
          if (current !== null && available.some((offer) => offer.plan_code === current)) return current;
          const regular = available.filter((offer) => !offer.test);
          const preferred = initialKind === null ? undefined : regular.find((offer) => offer.kind === initialKind);
          return preferred?.plan_code ?? null;
        });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || isAbortError(error)) return;
        setPlansRequest({ status: 'error', unauthorized: isApiError(error) && error.code === 'UNAUTHORIZED' });
      });
    return () => {
      controller.abort();
    };
  }, [api, compatibilityPurchase, initialKind, offersReport, reloadPlans, reportChartId, subscribed, subscriptions]);

  /** Asks the server whether the purchase arrived, `attempts` times at most. */
  const confirm = async (
    bought: { planCode: OrderablePlanCode; kind: PlanKind; report: boolean },
    chartId: string | null,
    attempts: number,
    signal: AbortSignal,
  ) => {
    setAwaited({ ...bought, chartId });
    setPhase('confirming');
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      let fresh: Me | null = null;
      try {
        if (attempt > 0) await wait(CONFIRM_INTERVAL_MS, signal);
        if (compatibilityPurchase && bought.planCode === 'compat_249') {
          if (refreshCompatibility === undefined) continue;
          const compatibility = await refreshCompatibility(signal);
          if (signal.aborted) return;
          if (compatibility.quota.kind === 'purchase' && compatibility.quota.left > 0) {
            track('payment_succeeded', { plan_code: bought.planCode });
            onCompatibilityPaid?.();
            return;
          }
        } else {
          fresh = await refreshMe(signal);
        }
      } catch (error) {
        if (signal.aborted || isAbortError(error)) return;
        // A question that got no answer is a question that confirmed nothing.
      }
      if (signal.aborted) return;
      if (fresh !== null && grants(fresh, bought.report, chartId)) {
        // Counted by the app, where the server's answer lands: a payment confirmed from another screen counts the same.
        if (bought.kind === 'one_off' && chartId !== null) onReportPaid();
        else {
          if (fresh.subscription.is_active && !fresh.has_chart) setSubscriptionSuccessWithoutChart(fresh);
          setPhase('choosing');
        }
        return;
      }
    }
    setPhase('processing');
  };

  const refreshCatalogue = () => {
    setProblem(null);
    setInvoices({});
    setPlansRequest({ status: 'loading' });
    setReloadPlans((count) => count + 1);
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
    track('checkout_started', { plan_code: plan.plan_code });

    let invoice = invoices[plan.plan_code];
    if (invoice === undefined) {
      setPhase('invoicing');
      // A one-off is associated with the chart currently shown, when there is one.
      const forChart = isReportOffer(plan) && reportChartId !== null ? { chart_id: reportChartId } : null;
      try {
        invoice = await api.createInvoice({ plan_code: plan.plan_code, ...forChart }, signal);
      } catch (error) {
        if (signal.aborted || isAbortError(error)) return;
        setPhase('choosing');
        if (onChartGone && forChart !== null && fieldErrorsOf(error).some(({ field }) => field === 'chart_id')) {
          // The chart the report was to be bought for is not the user's any more. Nothing to show of it: the app leads on.
          onChartGone();
          return;
        }
        setProblem(problemOf(error));
        track('error_shown', { screen: 'paywall', code: failureCodeOf(error) });
        return;
      }
      if (signal.aborted) return;
      const made = invoice;
      setInvoices((current) => ({ ...current, [plan.plan_code]: made }));
      if (made.stars !== plan.stars) {
        // A changed server price invalidates this checkout. Do not cache or open the mismatched invoice.
        setPhase('choosing');
        setInvoices((current) => ({ ...current, [plan.plan_code]: undefined }));
        setProblem({ kind: 'price_changed' });
        // The API 1.6.0 closed event enum has no `price_mismatch_shown`; use its safe generic event/code.
        track('error_shown', { screen: 'paywall', code: 'price_mismatch' });
        return;
      }
    }

    setPhase('paying');
    track('checkout_opened', { plan_code: plan.plan_code });
    const outcome = await telegram.openInvoice(invoice.invoice_link);
    const maybePaid = outcome === 'paid' || outcome === 'pending';
    // Said before anything else, and even if the screen is gone by now: from here on the app must not offer to pay for this again.
    if (maybePaid) onAwaiting?.(plan, isReportOffer(plan));
    if (signal.aborted) {
      // The screen was left while the invoice was open. The server is still asked: the rest of the app shows what it grants.
      if (maybePaid) void refreshMe().catch(() => undefined);
      return;
    }
    switch (outcome) {
      case 'cancelled':
        // The user changed their mind. Not a failure: nothing to say about it.
        track('payment_cancelled', { plan_code: plan.plan_code });
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
        setInvoices((current) => ({ ...current, [plan.plan_code]: undefined }));
        await confirm(
          { planCode: plan.plan_code, kind: plan.kind, report: isReportOffer(plan) },
          isReportOffer(plan) ? reportChartId : null,
          CONFIRM_ATTEMPTS[outcome],
          signal,
        );
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
              if (awaited !== null && signal !== undefined) void confirm(awaited, awaited.chartId, 1, signal);
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
  if (subscriptionSuccessWithoutChart !== null) {
    const successExpiry = subscriptionSuccessWithoutChart.subscription.expires_at;
    const successLine = successExpiry === null ? copy.active : copy.activeUntil(formatDay(successExpiry));
    return (
      <Screen back={back}>
        <StateView icon={<StarsIcon />} title={successLine} text={copy.subscriptionWithoutChart}>
          <Button onClick={onBuildChart ?? onClose}>{copy.buildChart}</Button>
        </StateView>
      </Screen>
    );
  }
  if (plansRequest.status === 'loading') {
    return (
      <Screen labelledBy={titleId} back={back} busy>
        <div className={styles.content}>
          <ScreenHeading id={titleId} title={copy.title} text={copy.lead} focusOnMount />
          <SkeletonGroup label={copy.loadingPlans} className={styles.options}>
            {[0, 1, 2].map((item) => <Skeleton key={item} variant="block" />)}
          </SkeletonGroup>
        </div>
      </Screen>
    );
  }
  if (plansRequest.status === 'error') {
    const expired = plansRequest.unauthorized;
    return (
      <Screen back={back}>
        <StateView
          icon={<StarsIcon />}
          title={expired ? copy.sessionExpired : copy.plansError}
        >
          {!expired && (
            <Button
              onClick={() => {
                setPlansRequest({ status: 'loading' });
                setReloadPlans((count) => count + 1);
              }}
            >
              {copy.retryPlans}
            </Button>
          )}
        </StateView>
      </Screen>
    );
  }
  if (visiblePlans.length === 0) {
    return (
      <Screen back={back}>
        <StateView icon={<StarsIcon />} title={expectedPlanMissing ? copy.priceUnavailable : subscribed ? activeLine : copy.nothingOnSale}>
          {expectedPlanMissing ? (
            <Button onClick={refreshCatalogue}>{copy.retryPlans}</Button>
          ) : onOpenReport ? (
            <Button onClick={onOpenReport}>{ru.chart.openReport}</Button>
          ) : (
            <Button onClick={onClose}>{copy.leave}</Button>
          )}
        </StateView>
      </Screen>
    );
  }

  const busy = phase !== 'choosing';
  const reportOffer = offered.find((offer) => offer.kind === 'one_off');
  const renderOffer = (offer: PlanOffer) => (
    <div key={offer.plan_code} className={styles.offer}>
      <OptionCard
        name={groupName}
        value={offer.plan_code}
        checked={plan?.plan_code === offer.plan_code}
        onSelect={(value) => {
          setChosen(value);
          setProblem(null);
        }}
        title={offer.title}
        description={offer.kind === 'subscription' ? undefined : offer.subtitle}
        aside={<Stars count={priceOf(offer)} />}
      />
      {offer.includes.filter((item) => offer.kind !== 'subscription' || !copy30.unapprovedSubscriptionClaim.test(item)).length > 0 && (
        <ul className={styles.includes}>
          {offer.includes.filter((item) => offer.kind !== 'subscription' || !copy30.unapprovedSubscriptionClaim.test(item)).map((item, index) => <li key={`${String(index)}:${item}`}>{item}</li>)}
        </ul>
      )}
    </div>
  );
  return (
    <Screen
      labelledBy={titleId}
      back={back}
      busy={busy}
      footer={
        <>
          {problem && <ProblemNote problem={problem} onRefresh={refreshCatalogue} />}
          {problem?.kind !== 'price_changed' && (
            <Button
              disabled={plan === null || busy}
              onClick={() => {
                void pay();
              }}
            >
              <PayLabel phase={phase} price={plan === null ? null : priceOf(plan)} />
            </Button>
          )}
          {plan?.test && <p className={styles.note}>{copy.testPlansNote}</p>}
        </>
      }
    >
      <div className={styles.content}>
        <ScreenHeading
          id={titleId}
          title={compatibilityPurchase ? ru.compatibility.title : copy.title}
          text={compatibilityPurchase ? ru.compatibility.purchaseDisclosure : copy.lead}
          focusOnMount
        />
        {reportRequired && reportOffer !== undefined && (
          <Notice>
            {copy.reportRequired} <Stars count={priceOf(reportOffer)} />
          </Notice>
        )}
        {subscribed && <Notice>{activeLine}</Notice>}
        {offered.length > 0 && (
          <fieldset className={styles.options} disabled={busy}>
            <legend>
              <VisuallyHidden>{copy.optionsLabel}</VisuallyHidden>
            </legend>
            {offered.map(renderOffer)}
          </fieldset>
        )}
        {testOffered.length > 0 && (
          <section className={styles.testOffers} aria-labelledby={`${titleId}-test-plans`}>
            <h2 id={`${titleId}-test-plans`} className={styles.testTitle}>{copy.testPlans}</h2>
            <fieldset className={styles.options} disabled={busy}>
              <legend>
                <VisuallyHidden>{copy.testPlans}</VisuallyHidden>
              </legend>
              {testOffered.map(renderOffer)}
            </fieldset>
          </section>
        )}
        {offersReport && offered.some((offer) => offer.kind === 'subscription') && <p className={styles.note}>{copy.reportIsSeparate}</p>}
        {plan?.kind === 'subscription' && <p className={styles.note}>{copy.renewal}</p>}
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

function ProblemNote({ problem, onRefresh }: { problem: Problem; onRefresh: () => void }) {
  const requestId = 'requestId' in problem ? problem.requestId : undefined;
  return (
    <div className={styles.problem} role="alert">
      <Notice tone="warning">
        <ProblemText problem={problem} />
      </Notice>
      {problem.kind === 'price_changed' && <Button onClick={onRefresh}>{copy.priceChangedAction}</Button>}
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
      return <>{copy.priceChanged}</>;
    default:
      return <>{problem.text}</>;
  }
}
