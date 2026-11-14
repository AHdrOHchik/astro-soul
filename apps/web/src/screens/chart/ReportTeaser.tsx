import { Button, Card, LockIcon, Skeleton, SkeletonGroup } from '@astro-soul/ui';
import { useCallback, useId, useState } from 'react';
import type { Api, Report } from '../../api';
import { Stars } from '../../components/Stars';
import { useRequest } from '../../hooks/useRequest';
import { ru } from '../../i18n/ru';
import { expectedStars, REPORT_PLAN } from '../../lib/plans';
import styles from './ReportTeaser.module.css';

const copy = ru.chart;
const HIDDEN_LINES = [0, 1, 2];

export interface ReportTeaserProps {
  api: Pick<Api, 'getReport'>;
  /** The chart on screen: a report about another chart is not this chart's report. */
  chartId: string;
  /** `Me.entitlements.full_report`: the server's word that a full report is paid for. */
  fullReport: boolean;
  /** The report the app knows of (`Me.latest_report_id`, or one met in this session); null when there is none. */
  reportId: string | null;
  /** What the server last said about that report, when the app has already heard it: shown while it is asked again. */
  known?: Report | null;
  /** The server's fresh word about the report. Keep the reference stable: a new function is a new request. */
  onKnown?: (report: Report) => void;
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
 */
export function ReportTeaser({
  api,
  chartId,
  fullReport,
  reportId,
  known = null,
  onKnown,
  paymentPending = false,
  onCheckPayment,
  onBuy,
  onOrder,
  onOpen,
}: ReportTeaserProps) {
  const titleId = useId();
  // The server names the last report of the user, whatever chart it is about: only this chart's counts here.
  const ofThisChart = useCallback((report: Report) => report.chart_id === null || report.chart_id === chartId, [chartId]);
  const load = useCallback(
    async (signal: AbortSignal): Promise<Report | null> => {
      if (reportId === null) return null;
      const report = await api.getReport(reportId, signal);
      if (!signal.aborted) onKnown?.(report);
      return ofThisChart(report) ? report : null;
    },
    [api, reportId, ofThisChart, onKnown],
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
            fullReport={fullReport}
            paymentPending={paymentPending}
            onCheckPayment={onCheckPayment}
            onBuy={onBuy}
            onOrder={onOrder}
            onOpen={onOpen}
          />
        )}
      </div>
    </Card>
  );
}

type BodyProps = Pick<ReportTeaserProps, 'fullReport' | 'paymentPending' | 'onCheckPayment' | 'onBuy' | 'onOrder' | 'onOpen'> & {
  report: Report | null;
};

function Body({ report, fullReport, paymentPending, onCheckPayment, onBuy, onOrder, onOpen }: BodyProps) {
  const [checking, setChecking] = useState(false);
  if (report !== null && (report.is_paid || report.status === 'failed' || report.status === 'refunded')) {
    // There is a report to open: paid for, or one that failed and has something to say about it.
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
  if (report === null && fullReport) {
    // Paid for and not ordered yet, as far as the app knows. The server knows for sure: it answers the order.
    return <Button onClick={onOrder}>{copy.orderReport}</Button>;
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
      <Button onClick={onBuy}>
        <span>
          {copy.teaserCta} <Stars count={expectedStars(REPORT_PLAN)} />
        </span>
      </Button>
    </>
  );
}
