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
  /**
   * The report the app knew of is no longer on the server (404): it went with the user's
   * data. Whoever remembers the report forgets it.
   */
  onReportGone?: (reportId: string) => void;
  /**
   * The server has no such chart to make a report about (404 to the order): it went with
   * the user's data, deleted elsewhere while this page stayed open. The caller leads on
   * from there, and nothing of the server's answer is shown. Without this prop the
   * refusal is shown like any other failure.
   */
  onChartGone?: () => void;
  /**
   * Asked when the server has no such report (404), before the screen shows anything about
   * it: is the chart still on the server? A report goes with the user's data, so the usual
   * reason is that the data was deleted elsewhere. `false`: the chart is gone too, the
   * caller leads on from there, and this screen shows nothing more. `true`, or a question
   * that failed: the screen goes on as it does without this prop.
   */
  isChartThere?: (signal?: AbortSignal) => Promise<boolean>;
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
  onReportGone,
  onChartGone,
  isChartThere,
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
  const latest = useRef({ track, onPaymentRequired, onReportId, onReport, onReportGone, onChartGone, isChartThere, justPaid });
  useEffect(() => {
    latest.current = { track, onPaymentRequired, onReportId, onReport, onReportGone, onChartGone, isChartThere, justPaid };
  });
  // The report this screen has ordered itself. Any other one the app knew of before the screen opened.
  const orderedHere = useRef<string | null>(null);

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
        orderedHere.current = report.report_id;
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
        if (isApiError(error) && error.code === 'NOT_FOUND' && latest.current.onChartGone) {
          // An order names a chart, and a 404 to it is the contract's «no such chart». Nothing failed that
          // the user could repeat or report: the chart is gone, and the app starts from what the server has.
          latest.current.onChartGone();
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
    const asked = reportId;
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
      api.getReport(asked, signal).then(
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
          const fail = () => {
            over = true;
            clearTimeout(stallTimer);
            if (!isApiError(error)) console.error(error);
            latest.current.track('error_shown', { screen: 'report', code: failureCodeOf(error) });
            setView({ kind: 'error', error, from: 'load' });
          };
          if (isApiError(error) && error.code === 'NOT_FOUND') {
            // The server has no such report: nothing more is asked about it.
            over = true;
            clearTimeout(stallTimer);
            const settle = () => {
              if (asked === orderedHere.current) {
                // One this screen has just ordered: the server took the order and then lost it, and that is a failure to show.
                fail();
                return;
              }
              // The report the app knew of is gone: deleted with the user's data. Nothing failed, so
              // nothing is shown and nothing is counted: the report is forgotten, and the screen is
              // what it is with no report.
              latest.current.onReportGone?.(asked);
              setReportId(null);
              setView({ kind: 'idle' });
            };
            const check = latest.current.isChartThere;
            if (check === undefined) {
              settle();
              return;
            }
            // First, whether the chart is gone as well. If it is, the caller is leading the user on, and the
            // screen stays as it was for that moment: not a word about a report of data that no longer exists.
            check(signal).then(
              (there) => {
                if (!signal.aborted && there) settle();
              },
              () => {
                if (!signal.aborted) settle();
              },
            );
            return;
          }
          const passing = isApiError(error) && PASSING.includes(error.code);
          if (shown !== null && passing) {
            // A report is on screen: one lost answer does not take it away. Asked again, later.
            unchanged += 1;
            if (!document.hidden) schedule();
            return;
          }
          fail();
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
    } catch (error) {
      // The report on screen is not on the server any more. Whether the chart is, the caller finds out, and leads on if not.
      if (isApiError(error) && error.code === 'NOT_FOUND') void latest.current.isChartThere?.().catch(() => undefined);
      return null;
    }
  }, [api, reportId]);

  return { view, order, reload, refresh };
}
