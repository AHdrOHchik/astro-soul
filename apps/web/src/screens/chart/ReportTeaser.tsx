import { Button, Card, LockIcon, Skeleton, SkeletonGroup } from '@astro-soul/ui';
import { useCallback, useEffect, useId, useState } from 'react';
import { isAbortError, isApiError, type Api, type Report } from '../../api';
import { Stars } from '../../components/Stars';
import { useRequest } from '../../hooks/useRequest';
import { formatDayMonthOf } from '../../i18n/format';
import { ru } from '../../i18n/ru';
import { REPORT_PLAN } from '../../lib/plans';
import { reportOpenFor, type ReportAccessState } from '../../lib/reportAccess';
import styles from './ReportTeaser.module.css';

const copy = ru.chart;
const HIDDEN_LINES = [0, 1, 2];
type ReportPrice = { status: 'loading' } | { status: 'ready'; stars: number | null } | { status: 'error'; unauthorized: boolean };

export interface ReportTeaserProps {
  api: Pick<Api, 'getPlans' | 'getReport'>;
  /** The chart on screen: a report about another chart is not this chart's report. */
  chartId: string;
  /**
   * The server's answer to «may this user have a report now» (`Me.report_access`), read through
   * `useReportAccess`. The teaser shows what it allows and never decides it: a price appears only
   * when the server says there is no access, and the wording of the button follows the answer.
   */
  access: ReportAccessState;
  /** Asks the server again when the access could not be told. */
  onRefreshAccess?: () => Promise<unknown>;
  /** The report the app knows of (`Me.latest_report_id`, or one met in this session); null when there is none. */
  reportId: string | null;
  /** What the server last said about that report, when the app has already heard it: shown while it is asked again. */
  known?: Report | null;
  /** The server's fresh word about the report. Keep the reference stable: a new function is a new request. */
  onKnown?: (report: Report) => void;
  /** The server no longer has that report (404): the app forgets it. Keep the reference stable, like `onKnown`. */
  onGone?: (reportId: string) => void;
  /**
   * Telegram called the report paid in this visit and the server has not granted it yet.
   * The price is not offered meanwhile: the user would pay twice for one report.
   */
  paymentPending?: boolean;
  /** Asks the server again whether the payment has arrived. */
  onCheckPayment?: () => Promise<unknown>;
  /** The button under the locked opening: on to the paywall, with the report already chosen. */
  onBuy: () => void;
  /** The tap that orders the report. */
  onOrder: () => void;
  /** Opens the report the app knows of. */
  onOpen: (reportId: string) => void;
}

/**
 * The full report as the chart screen shows it: what the user has of it, and the one
 * step that follows.
 *
 * Before the purchase there is the opening the server gives out (`report.teaser`), three
 * lines of it, and under it shapes that stand for the rest. The rest itself is not here in
 * any form: the server does not send it unpaid, and this block would not draw it if it did.
 *
 * Whether the report is open, and why, comes from `Me.report_access` and from nothing else:
 * a missing answer is said out loud instead of turning into a price.
 */
export function ReportTeaser({
  api,
  chartId,
  access,
  onRefreshAccess,
  reportId,
  known = null,
  onKnown,
  onGone,
  paymentPending = false,
  onCheckPayment,
  onBuy,
  onOrder,
  onOpen,
}: ReportTeaserProps) {
  const titleId = useId();
  const open = reportOpenFor(access, chartId);
  // The price is asked for only where the server said there is no access to this chart: never next to a report
  // that is open, and never in place of the answer it did not give (`unknown`).
  const needsReportPrice = (access.status === 'none' || (access.status === 'open' && !open)) && !paymentPending;
  const [priceAttempt, setPriceAttempt] = useState(0);
  const [reportPrice, setReportPrice] = useState<ReportPrice>({ status: 'loading' });
  useEffect(() => {
    if (!needsReportPrice) return undefined;
    const controller = new AbortController();
    void api
      .getPlans(controller.signal)
      .then((plans) => {
        if (controller.signal.aborted) return;
        const offer = plans.find((item) => item.plan_code === REPORT_PLAN && !item.test);
        setReportPrice({ status: 'ready', stars: offer?.stars ?? null });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || isAbortError(error)) return;
        setReportPrice({ status: 'error', unauthorized: isApiError(error) && error.code === 'UNAUTHORIZED' });
      });
    return () => {
      controller.abort();
    };
  }, [api, needsReportPrice, priceAttempt]);
  // The server names the last report of the user, whatever chart it is about: only this chart's counts here.
  const ofThisChart = useCallback((report: Report) => report.chart_id === null || report.chart_id === chartId, [chartId]);
  const load = useCallback(
    async (signal: AbortSignal): Promise<Report | null> => {
      if (reportId === null) return null;
      try {
        const report = await api.getReport(reportId, signal);
        if (!signal.aborted) onKnown?.(report);
        return ofThisChart(report) ? report : null;
      } catch (error) {
        // `Me` named a report the server no longer has: it went with the user's data. Not a
        // failure: there is no report, the block says what it says without one, and the app forgets the id.
        if (!isApiError(error) || error.code !== 'NOT_FOUND') throw error;
        if (!signal.aborted) onGone?.(reportId);
        return null;
      }
    },
    [api, reportId, ofThisChart, onKnown, onGone],
  );
  const state = useRequest(load);
  // What the app has heard before stands in until the server answers: coming back to the chart does not blink.
  const heard = known !== null && known.report_id === reportId && ofThisChart(known) ? known : null;
  // Without a report to ask about there is nothing to wait for.
  const loading = reportId !== null && state.status === 'loading' && heard === null;
  // A report that could not be asked about is treated as none: the report screen will say what is wrong when it is opened.
  let report: Report | null = null;
  if (state.status === 'ready') report = state.data;
  else if (state.status === 'loading') report = heard;

  return (
    <Card labelledBy={titleId}>
      <div className={styles.teaser}>
        <h2 id={titleId} className={styles.title}>
          {copy.teaserTitle}
        </h2>
        {loading ? (
          <SkeletonGroup label={copy.reportLoading}>
            <Skeleton />
          </SkeletonGroup>
        ) : (
          <Body
            report={report}
            open={open}
            access={access}
            onRefreshAccess={onRefreshAccess}
            paymentPending={paymentPending}
            onCheckPayment={onCheckPayment}
            onBuy={onBuy}
            onOrder={onOrder}
            onOpen={onOpen}
            reportPrice={reportPrice}
            onRetryPrice={() => {
              setReportPrice({ status: 'loading' });
              setPriceAttempt((attempt) => attempt + 1);
            }}
          />
        )}
      </div>
    </Card>
  );
}

type BodyProps = Pick<
  ReportTeaserProps,
  'access' | 'onRefreshAccess' | 'paymentPending' | 'onCheckPayment' | 'onBuy' | 'onOrder' | 'onOpen'
> & {
  report: Report | null;
  /** Whether this state opens a report about this very chart (another chart's purchase does not). */
  open: boolean;
  reportPrice: ReportPrice;
  onRetryPrice: () => void;
};

/** Why the report is open, in the words of the server's source: a right with a term, a free report, a purchase. */
function accessNote(access: Extract<ReportAccessState, { status: 'open' }>): string | null {
  if (access.source === 'all_access') {
    const day = access.expiresAt === null ? '' : formatDayMonthOf(access.expiresAt);
    return day === '' ? copy.accessOpen : copy.accessUntil(day);
  }
  if (access.source === 'single_report') return copy.accessSingle;
  if (access.source === 'purchased') return null;
  return copy.accessOpen;
}

function Body({ report, open, access, onRefreshAccess, paymentPending, onCheckPayment, onBuy, onOrder, onOpen, reportPrice, onRetryPrice }: BodyProps) {
  const [checking, setChecking] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  if (report !== null && (report.is_paid || report.status === 'failed' || report.status === 'refunded')) {
    // There is a report to open: paid for, granted, or one that failed and has something to say about it.
    return (
      <>
        <p>{copy.reportStates[report.status]}</p>
        <Button
          onClick={() => {
            onOpen(report.report_id);
          }}
        >
          {copy.openReport}
        </Button>
      </>
    );
  }
  if (paymentPending) {
    // Paid by Telegram's word, not granted by the server yet. No price here: a second payment would be for the same report.
    return (
      <>
        <p>{copy.paymentPending}</p>
        <Button
          variant="secondary"
          disabled={checking}
          onClick={() => {
            setChecking(true);
            void Promise.resolve(onCheckPayment?.())
              .catch(() => undefined)
              .then(() => {
                setChecking(false);
              });
          }}
        >
          {ru.paywall.checkAgain}
        </Button>
      </>
    );
  }
  if (access.status === 'unknown') {
    // The server did not say. Not «no access» and certainly not a price: the app says what it does not know.
    return (
      <>
        <p role="alert">{copy.accessUnknown}</p>
        <Button
          variant="secondary"
          disabled={refreshing}
          onClick={() => {
            setRefreshing(true);
            void Promise.resolve(onRefreshAccess?.())
              .catch(() => undefined)
              .then(() => {
                setRefreshing(false);
              });
          }}
        >
          {copy.refreshAccess}
        </Button>
      </>
    );
  }
  if (open && access.status === 'open') {
    // The report is open, whatever the price is: the one step left is ordering it. The server names the reason, if there is one.
    const note = accessNote(access);
    return (
      <>
        {report !== null && report.teaser !== '' && <p className={styles.opening}>{report.teaser}</p>}
        <Button onClick={onOrder}>{copy.orderReport}</Button>
        {note !== null && <p className={styles.note}>{note}</p>}
      </>
    );
  }
  if (reportPrice.status === 'loading') {
    return (
      <>
        {report !== null && report.teaser !== '' && <p className={styles.opening}>{report.teaser}</p>}
        <SkeletonGroup label={ru.paywall.loadingPlans}>
          <Skeleton />
        </SkeletonGroup>
      </>
    );
  }
  if (reportPrice.status === 'error') {
    return reportPrice.unauthorized ? (
      <p role="alert">{ru.paywall.sessionExpired}</p>
    ) : (
      <>
        <p role="alert">{ru.paywall.plansError}</p>
        <Button variant="secondary" onClick={onRetryPrice}>{ru.paywall.retryPlans}</Button>
      </>
    );
  }

  return (
    <>
      {report !== null && report.teaser !== '' && <p className={styles.opening}>{report.teaser}</p>}
      <div className={styles.locked}>
        <div className={styles.hidden} aria-hidden="true">
          {HIDDEN_LINES.map((line) => (
            <span key={line} className={styles.line} />
          ))}
        </div>
        <p className={styles.badge}>
          <LockIcon />
          <span className={styles.badgeText}>{copy.teaserLocked}</span>
        </p>
      </div>
      {reportPrice.stars !== null && (
        <Button onClick={onBuy}>
          {copy.teaserCta} <Stars count={reportPrice.stars} />
        </Button>
      )}
    </>
  );
}
