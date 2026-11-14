import {
  AlertIcon,
  Button,
  DownloadIcon,
  InfoIcon,
  Notice,
  Progress,
  Screen,
  ScreenHeading,
  ShareIcon,
  Skeleton,
  SkeletonGroup,
  StarsIcon,
  StateView,
  type ScreenProps,
} from '@astro-soul/ui';
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode, type Ref } from 'react';
import type { Track } from '../../analytics';
import { absoluteApiUrl, isApiError, rejectionTextOf, REPORT_SECTION_KEYS, type Api, type Report, type ReportSection } from '../../api';
import { ErrorState } from '../../components/ErrorState';
import { Markdown } from '../../components/Markdown';
import { Reference } from '../../components/Reference';
import { Stars } from '../../components/Stars';
import { SupportButton } from '../../components/SupportButton';
import { pluralForm } from '../../i18n/format';
import { ru } from '../../i18n/ru';
import type { IdempotencyKeys } from '../../lib/idempotency';
import { expectedStars, REPORT_PLAN } from '../../lib/plans';
import type { Telegram } from '../../telegram';
import styles from './ReportScreen.module.css';
import { useReport, type ReportFlow } from './useReport';

const copy = ru.report;
const SKELETON_LINES = [0, 1, 2, 3];

export interface ReportScreenProps {
  api: Pick<Api, 'orderReport' | 'getReport'>;
  telegram: Pick<Telegram, 'isTelegram' | 'close' | 'share' | 'openLink'>;
  keys: IdempotencyKeys;
  /** The chart the report is about. */
  chartId: string;
  /** A report the app already knows of; null when there is none to open. */
  reportId: string | null;
  /** Order as the screen opens: the tap that led here asked for the report. */
  orderAtOnce: boolean;
  /** The report was bought a moment ago. */
  justPaid: boolean;
  /** API origin that a relative `pdf_url` resolves against; '' = this page's origin. */
  apiBaseUrl: string;
  /** Where the support button leads; '' while there is no contact. */
  supportLink: string;
  /** What the share button sends: the picture of the chart and the words with it. Never the text of the report. */
  share: { url: string; text: string } | null;
  track: Track;
  back?: ScreenProps['back'];
  /** The server will not make the report without a purchase: on to the paywall. */
  onPaymentRequired: (explain: boolean) => void;
  onReportId?: (reportId: string) => void;
  /** Every new word of the server about the report: the chart screen shows the same report in short. */
  onReport?: (report: Report) => void;
}

/**
 * Screen 6. Orders the full report and shows it as it gets written.
 *
 * Everything on it is the server's word: the status, the progress, the chapters, and above
 * all whether the text is paid for. The screen opens nothing by itself.
 */
export function ReportScreen({
  api,
  telegram,
  keys,
  chartId,
  reportId,
  orderAtOnce,
  justPaid,
  apiBaseUrl,
  supportLink,
  share,
  track,
  back,
  onPaymentRequired,
  onReportId,
  onReport,
}: ReportScreenProps) {
  const titleId = useId();
  const flow = useReport({ api, keys, chartId, reportId, orderAtOnce, justPaid, track, onPaymentRequired, onReportId, onReport });
  const { view } = flow;
  const report = view.kind === 'report' ? view.report : null;

  // Once per report: a finished one seen, a failed one shown.
  const reported = useRef<string | null>(null);
  useEffect(() => {
    if (report === null) return;
    const mark = `${report.report_id}:${report.status}`;
    if (reported.current === mark) return;
    if (report.status === 'ready' && report.is_paid) track('report_ready_view', { report_id: report.report_id });
    else if (report.status === 'failed') track('error_shown', { screen: 'report', code: 'report_failed' });
    else return;
    reported.current = mark;
  }, [report, track]);

  // What appears or goes above the chapters (the progress, the contents list of a finished report)
  // must not move the text the user is reading: the scroll follows the first chapter.
  const body = useRef<HTMLElement>(null);
  const firstChapter = useRef<HTMLElement>(null);
  const anchoredAt = useRef<number | null>(null);
  useLayoutEffect(() => {
    const top = firstChapter.current?.offsetTop ?? null;
    const scroller = body.current;
    if (top !== null && anchoredAt.current !== null && scroller !== null && scroller.scrollTop > 0) {
      scroller.scrollTop += top - anchoredAt.current;
    }
    anchoredAt.current = top;
  });

  const support = <SupportButton link={supportLink} telegram={telegram} />;

  if (view.kind === 'idle') {
    return (
      <Screen
        labelledBy={titleId}
        back={back}
        footer={
          <Button
            onClick={() => {
              flow.order();
            }}
          >
            {copy.order}
          </Button>
        }
      >
        <ScreenHeading id={titleId} title={copy.title} text={copy.idleText} focusOnMount />
      </Screen>
    );
  }

  if (view.kind === 'pending') {
    return (
      <Screen labelledBy={titleId} back={back} busy>
        <div className={styles.content}>
          <ScreenHeading id={titleId} title={copy.title} focusOnMount />
          <SkeletonGroup label={view.what === 'order' ? copy.ordering : copy.loading} className={styles.skeleton}>
            {SKELETON_LINES.map((line) => (
              <Skeleton key={line} />
            ))}
          </SkeletonGroup>
        </div>
      </Screen>
    );
  }

  if (view.kind === 'processing') {
    return (
      <Screen back={back}>
        <StateView icon={<StarsIcon />} title={ru.paywall.processingTitle} text={ru.paywall.processingText}>
          <Button
            onClick={() => {
              flow.order();
            }}
          >
            {ru.paywall.checkAgain}
          </Button>
        </StateView>
      </Screen>
    );
  }

  if (view.kind === 'error') {
    return (
      <Screen back={back}>
        <Failure view={view} flow={flow} telegram={telegram} support={support} />
      </Screen>
    );
  }

  const { report: shown, stalled } = view;
  if (shown.status === 'failed') {
    return (
      <Screen back={back}>
        <StateView
          role="alert"
          icon={<AlertIcon />}
          title={copy.failedTitle}
          text={copy.failedText}
          caption={<Reference value={shown.report_id} label={copy.reportId(shown.report_id)} />}
        >
          <Button
            onClick={() => {
              flow.order({ renew: true });
            }}
          >
            {copy.retry}
          </Button>
          {support}
        </StateView>
      </Screen>
    );
  }
  if (shown.status === 'refunded') {
    // Not an error: the stars are back with the user, and the screen says exactly that.
    return (
      <Screen back={back}>
        <StateView
          icon={<InfoIcon />}
          title={copy.refundedTitle}
          text={copy.refundedText}
          caption={<Reference value={shown.report_id} label={copy.reportId(shown.report_id)} />}
        >
          <Button
            onClick={() => {
              flow.order({ renew: true });
            }}
          >
            {copy.retry}
          </Button>
          {support}
        </StateView>
      </Screen>
    );
  }

  if (!shown.is_paid) {
    return (
      <Screen
        labelledBy={titleId}
        back={back}
        footer={
          <Button
            onClick={() => {
              onPaymentRequired(false);
            }}
          >
            <span>
              {ru.chart.teaserCta} <Stars count={expectedStars(REPORT_PLAN)} />
            </span>
          </Button>
        }
      >
        <div className={styles.content}>
          <ScreenHeading id={titleId} title={copy.title} focusOnMount />
          {shown.teaser !== '' && <p className={styles.teaser}>{shown.teaser}</p>}
          <p className={styles.muted}>{copy.lockedText}</p>
        </div>
      </Screen>
    );
  }

  // In work or done: one layout for both, so the chapters already on screen stay the same elements when the report is finished.
  const done = shown.status === 'ready';
  const queued = shown.status === 'queued';
  const written = shown.sections.length;
  // The contract names seven chapters; a server that writes more is believed over the contract.
  const total = Math.max(REPORT_SECTION_KEYS.length, written);
  let title: string = copy.title;
  if (!done) title = queued ? copy.queuedTitle : copy.generatingTitle;
  return (
    <Screen labelledBy={titleId} back={back} bodyRef={body}>
      <div className={styles.content}>
        <ScreenHeading id={titleId} title={title} focusOnMount />
        {!done && (
          <div className={styles.progress}>
            {/* The server's number as it came. Short of 100 until the server calls the report ready. */}
            {shown.progress !== null && <Progress value={Math.min(shown.progress, 99)} label={copy.progressLabel} />}
            <p className={styles.muted} role="status">
              {queued ? copy.queuedText : copy.chaptersReady(written, total, pluralForm(total))}
            </p>
          </div>
        )}
        {!done && stalled && (
          <div className={styles.stalled}>
            <Notice>{copy.stalled}</Notice>
            {support}
          </div>
        )}
        <Chapters sections={shown.sections} contents={done} first={firstChapter} />
        {done && <Download report={shown} apiBaseUrl={apiBaseUrl} telegram={telegram} refresh={flow.refresh} />}
        {done && share && (
          <Button
            variant="secondary"
            icon={<ShareIcon />}
            onClick={() => {
              track('share_clicked');
              telegram.share(share.url, share.text);
            }}
          >
            {ru.chart.share}
          </Button>
        )}
      </div>
    </Screen>
  );
}

/** The chapters the server has sent, in its order, each under its own title. Nothing stands in for one that is not there. */
interface ChaptersProps {
  sections: readonly ReportSection[];
  /** Puts the contents list before the chapters: for a finished report. */
  contents?: boolean;
  /** The first chapter, for the screen to keep the scroll by. */
  first?: Ref<HTMLElement>;
}

function Chapters({ sections, contents = false, first }: ChaptersProps) {
  const baseId = useId();
  const headingId = (index: number) => `${baseId}-${String(index)}`;
  if (sections.length === 0) return null;
  return (
    <>
      {contents && sections.length > 1 && (
        <nav className={styles.contents} aria-label={copy.contents}>
          <h2 className={styles.contentsTitle}>{copy.contents}</h2>
          <ol className={styles.contentsList}>
            {sections.map((section, index) => (
              <li key={section.key}>
                <button
                  type="button"
                  className={styles.contentsLink}
                  onClick={() => {
                    const heading = document.getElementById(headingId(index));
                    heading?.scrollIntoView({ block: 'start' });
                    heading?.focus({ preventScroll: true });
                  }}
                >
                  {section.title}
                </button>
              </li>
            ))}
          </ol>
        </nav>
      )}
      {sections.map((section, index) => (
        <section
          key={section.key}
          ref={index === 0 ? first : undefined}
          className={styles.chapter}
          aria-labelledby={section.title === '' ? undefined : headingId(index)}
        >
          {section.title !== '' && (
            <h2 id={headingId(index)} className={styles.chapterTitle} tabIndex={-1}>
              {section.title}
            </h2>
          )}
          <Markdown text={section.body_md} />
        </section>
      ))}
    </>
  );
}

interface DownloadProps {
  report: Report;
  apiBaseUrl: string;
  telegram: Pick<Telegram, 'openLink'>;
  refresh: ReportFlow['refresh'];
}

/** True only for a link the server says is gone. A check that could not be made says nothing. */
async function isGone(url: string): Promise<boolean> {
  try {
    return (await fetch(url, { method: 'HEAD' })).status === 404;
  } catch {
    return false;
  }
}

/**
 * The download button, only when the server gave a link. The link is signed and expires, so it
 * lives in memory and nowhere else; one that has expired while the screen was open is asked
 * for again, once.
 */
function Download({ report, apiBaseUrl, telegram, refresh }: DownloadProps) {
  const [busy, setBusy] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  if (report.pdf_url === null) return null;
  const absolute = (path: string) => absoluteApiUrl(path, apiBaseUrl, window.location.origin) ?? path;

  const open = async (path: string) => {
    setBusy(true);
    setUnavailable(false);
    let url: string | null = absolute(path);
    if (await isGone(url)) {
      const fresh = await refresh();
      url = fresh?.pdf_url ? absolute(fresh.pdf_url) : null;
    }
    setBusy(false);
    if (url === null) setUnavailable(true);
    else telegram.openLink(url);
  };

  const path = report.pdf_url;
  return (
    <>
      <Button
        variant="secondary"
        icon={<DownloadIcon />}
        disabled={busy}
        onClick={() => {
          void open(path);
        }}
      >
        {copy.pdf}
      </Button>
      {unavailable && <Notice tone="warning">{copy.pdfUnavailable}</Notice>}
    </>
  );
}

interface FailureProps {
  view: Extract<ReportFlow['view'], { kind: 'error' }>;
  flow: ReportFlow;
  telegram: Pick<Telegram, 'isTelegram' | 'close'>;
  support: ReactNode;
}

/** A request that failed: the order, or the first question about a report. */
function Failure({ view, flow, telegram, support }: FailureProps) {
  const { error, from } = view;
  const code = isApiError(error) ? error.code : 'INTERNAL';
  if (from === 'load') {
    return (
      <ErrorState error={error} telegram={telegram} onRetry={flow.reload}>
        {/* The report the app knew of is gone: the way on is a new order. */}
        {code === 'NOT_FOUND' && (
          <Button
            onClick={() => {
              flow.order();
            }}
          >
            {copy.order}
          </Button>
        )}
      </ErrorState>
    );
  }
  const retry = () => {
    flow.order();
  };
  switch (code) {
    case 'VALIDATION_FAILED':
      // Our bug or an outdated build, not the user's doing: the server's words about the field, and the way to support.
      return (
        <ErrorState error={error} telegram={telegram} title={copy.orderRejectedTitle} text={rejectionTextOf(error)}>
          {support}
        </ErrorState>
      );
    case 'CONFLICT':
      // The server's message as it is.
      return (
        <ErrorState error={error} telegram={telegram} title={copy.orderRejectedTitle}>
          {support}
        </ErrorState>
      );
    case 'RATE_LIMITED':
      return <ErrorState error={error} telegram={telegram} text={copy.rateLimited} onRetry={retry} />;
    default:
      return <ErrorState error={error} telegram={telegram} onRetry={retry} />;
  }
}
