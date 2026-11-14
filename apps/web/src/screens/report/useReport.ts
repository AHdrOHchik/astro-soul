import { useCallback, useEffect, useRef, useState } from 'react';
import type { Track } from '../../analytics';
import { failureCodeOf, isAbortError, isApiError, type Api, type ApiErrorCode, type Report } from '../../api';
import type { IdempotencyKeys } from '../../lib/idempotency';

/** The only kind of report this screen orders. */
const REPORT_TYPE = 'full';

/**
 * The pause before the next question about a report, by how many answers in a row brought
 * nothing new: 2 s, then twice as long each time, 10 s at most. An answer with something
 * new starts the row over.
 */
export const POLL_DELAYS_MS = [2000, 4000, 8000, 10_000] as const;

/** A report whose answers have not changed for this long is «taking longer than usual». */
export const STALL_MS = 60_000;

/** Failures after which the same question may still get an answer. */
const PASSING: readonly ApiErrorCode[] = ['NETWORK', 'TIMEOUT', 'INTERNAL', 'UPSTREAM_LLM', 'RATE_LIMITED', 'INVALID_RESPONSE'];

/** What the screen shows. */
export type ReportView =
  /** Nothing is ordered and nothing is known: the button that orders. */
  | { kind: 'idle' }
  /** The order is on its way, or the first answer about a report is. */
  | { kind: 'pending'; what: 'order' | 'load' }
  /** The server's last word about the report. `stalled`: that word has not changed for `STALL_MS`. */
  | { kind: 'report'; report: Report; stalled: boolean }
  /** The purchase was made a moment ago and the server does not know of it yet. */
  | { kind: 'processing' }
  | { kind: 'error'; error: unknown; from: 'order' | 'load' };

export interface UseReportOptions {
  api: Pick<Api, 'orderReport' | 'getReport'>;
  keys: IdempotencyKeys;
  /** The chart the report is about. Sent with every order: the server does not pick one. */
  chartId: string;
  /** A report the app already knows of, to open instead of ordering. */
  reportId: string | null;
  /** Order as the screen opens: the user asked for the report with the tap that led here. */
  orderAtOnce: boolean;
  /** The report was bought a moment ago: «not paid» from the server then means «not processed yet». */
  justPaid: boolean;
  track: Track;
  /**
   * The server will not make the report without a purchase. `explain`: the refusal came to
   * an ordinary order, so the paywall says why it opened.
   */
  onPaymentRequired: (explain: boolean) => void;
  /** Tells which report this is as soon as the server names it. */
  onReportId?: (reportId: string) => void;
  /** Hands over every new word of the server about the report, for whoever shows the report elsewhere. */
  onReport?: (report: Report) => void;
}

export interface ReportFlow {
  view: ReportView;
  /**
   * Orders the report. Called from a tap: the idempotency key is taken at that moment, the
   * kept one, or with `renew` a new one, for an order the user makes again on purpose.
   */
  order: (options?: { renew?: boolean }) => void;
  /** Asks about the known report from the start, after a failure to load it. */
  reload: () => void;
  /** One more answer about the report on screen, outside the schedule. Null when it could not be had. */
  refresh: () => Promise<Report | null>;
}

interface OrderRun {
  key: string;
  /** A 402 to this order is explained on the paywall. */
  explain: boolean;
}

const isOver = (report: Report) => report.status === 'ready' || report.status === 'failed' || report.status === 'refunded';

/** What in a report can change between two answers. The same line twice: nothing new. */
const signatureOf = (report: Report) =>
  [report.status, report.progress ?? '', report.sections.length, report.is_paid, report.teaser.length, report.pdf_url ?? ''].join('|');

/**
 * Orders a report and follows it until it is over.
 *
 * The answers are asked for one after another: the first right after the order is taken,
 * the next ones after the pauses of `POLL_DELAYS_MS`. Nothing is asked while the page is
 * hidden, and nothing after the screen is left.
 */
export function useReport({
  api,
  keys,
  chartId,
  reportId: knownReportId,
  orderAtOnce,
  justPaid,
  track,
  onPaymentRequired,
  onReportId,
  onReport,
}: UseReportOptions): ReportFlow {
  const [reportId, setReportId] = useState(knownReportId);
  // The key of the first order is taken here, once: a development build runs the effect below twice, with this one key.
  const [run, setRun] = useState<OrderRun | null>(() =>
    orderAtOnce && knownReportId === null ? { key: keys.current(chartId, REPORT_TYPE), explain: true } : null,
  );
  const [view, setView] = useState<ReportView>(() => {
    if (knownReportId !== null) return { kind: 'pending', what: 'load' };
    return orderAtOnce ? { kind: 'pending', what: 'order' } : { kind: 'idle' };
  });
  const [loads, setLoads] = useState(0);

  // The callbacks of the moment, for effects that must not start over when a parent renders.
  const latest = useRef({ track, onPaymentRequired, onReportId, onReport, justPaid });
  useEffect(() => {
    latest.current = { track, onPaymentRequired, onReportId, onReport, justPaid };
  });

  // The order.
  useEffect(() => {
    if (run === null) return undefined;
    const controller = new AbortController();
    const { signal } = controller;
    // Counted a moment later, and only if still wanted: a development build cancels its first run on the spot.
    void Promise.resolve().then(() => {
      if (!signal.aborted) latest.current.track('report_requested');
    });
    api.orderReport({ chart_id: chartId, type: REPORT_TYPE }, run.key, signal).then(
      (report) => {
        if (signal.aborted) return;
        // Only the id is taken from this answer: what the report is like is asked next, and at once.
        latest.current.onReportId?.(report.report_id);
        setRun(null);
        setView({ kind: 'pending', what: 'load' });
        setReportId(report.report_id);
      },
      (error: unknown) => {
        if (signal.aborted || isAbortError(error)) return;
        setRun(null);
        if (isApiError(error) && error.code === 'PAYMENT_REQUIRED') {
          if (latest.current.justPaid) {
            setView({ kind: 'processing' });
            return;
          }
          latest.current.track('quota_exhausted', { step: 'report' });
          latest.current.onPaymentRequired(run.explain);
          return;
        }
        if (!isApiError(error)) console.error(error);
        latest.current.track('error_shown', { screen: 'report', code: failureCodeOf(error) });
        setView({ kind: 'error', error, from: 'order' });
      },
    );
    return () => {
      controller.abort();
    };
  }, [api, chartId, run]);

  // The answers about the report.
  useEffect(() => {
    if (reportId === null) return undefined;
    const controller = new AbortController();
    const { signal } = controller;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stallTimer: ReturnType<typeof setTimeout> | undefined;
    let asking = false;
    let over = false;
    /** Answers in a row that brought nothing new. */
    let unchanged = 0;
    let seen: string | null = null;
    let shown: Report | null = null;

    const show = (report: Report, stalled: boolean) => {
      if (shown !== report) latest.current.onReport?.(report);
      shown = report;
      setView({ kind: 'report', report, stalled });
    };
    const watchForStall = () => {
      clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        if (shown !== null && !over) show(shown, true);
      }, STALL_MS);
    };
    const schedule = () => {
      timer = setTimeout(ask, POLL_DELAYS_MS[Math.min(unchanged, POLL_DELAYS_MS.length - 1)]);
    };

    function ask(): void {
      timer = undefined;
      // Telegram is minimised all the time: nothing is asked meanwhile, `visibilitychange` picks it up.
      if (document.hidden || asking) return;
      asking = true;
      api.getReport(reportId ?? '', signal).then(
        (report) => {
          asking = false;
          if (signal.aborted) return;
          const signature = signatureOf(report);
          const changed = signature !== seen;
          seen = signature;
          if (isOver(report)) {
            over = true;
            clearTimeout(stallTimer);
            show(report, false);
            return;
          }
          if (changed) {
            unchanged = 0;
            watchForStall();
            show(report, false);
          } else {
            unchanged += 1;
          }
          if (!document.hidden) schedule();
        },
        (error: unknown) => {
          asking = false;
          if (signal.aborted || isAbortError(error)) return;
          const passing = isApiError(error) && PASSING.includes(error.code);
          if (shown !== null && passing) {
            // A report is on screen: one lost answer does not take it away. Asked again, later.
            unchanged += 1;
            if (!document.hidden) schedule();
            return;
          }
          over = true;
          clearTimeout(stallTimer);
          if (!isApiError(error)) console.error(error);
          latest.current.track('error_shown', { screen: 'report', code: failureCodeOf(error) });
          setView({ kind: 'error', error, from: 'load' });
        },
      );
    }

    const onVisibility = () => {
      if (document.hidden) {
        clearTimeout(timer);
        timer = undefined;
        // Nobody was watching: time spent hidden is not time the report stood still.
        clearTimeout(stallTimer);
        return;
      }
      if (over || timer !== undefined) return;
      unchanged = 0;
      if (shown !== null) watchForStall();
      ask();
    };

    document.addEventListener('visibilitychange', onVisibility);
    ask();
    return () => {
      controller.abort();
      clearTimeout(timer);
      clearTimeout(stallTimer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [api, reportId, loads]);

  const order = useCallback<ReportFlow['order']>(
    ({ renew = false } = {}) => {
      // The key of this order, taken at the tap. A new one only when the user orders again on purpose.
      const key = renew ? keys.renew(chartId, REPORT_TYPE) : keys.current(chartId, REPORT_TYPE);
      // Whatever report was followed until now is left alone: this is another order.
      setReportId(null);
      setView({ kind: 'pending', what: 'order' });
      setRun({ key, explain: !renew });
    },
    [keys, chartId],
  );

  const reload = useCallback(() => {
    setView({ kind: 'pending', what: 'load' });
    setLoads((count) => count + 1);
  }, []);

  const refresh = useCallback(async () => {
    if (reportId === null) return null;
    try {
      const report = await api.getReport(reportId);
      setView((current) => (current.kind === 'report' ? { ...current, report } : current));
      return report;
    } catch {
      return null;
    }
  }, [api, reportId]);

  return { view, order, reload, refresh };
}
