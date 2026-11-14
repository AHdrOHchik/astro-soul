import {
  AscendantIcon,
  Button,
  GearIcon,
  InfoIcon,
  MoonIcon,
  Notice,
  Screen,
  ScreenHeading,
  ShareIcon,
  Skeleton,
  SkeletonGroup,
  StateView,
  SunIcon,
  VisuallyHidden,
  type ScreenProps,
} from '@astro-soul/ui';
import { useCallback, useId, useLayoutEffect, useRef, useState } from 'react';
import { errorCodeOf, trackRejection, type Track } from '../../analytics';
import {
  absoluteApiUrl,
  fieldErrorsOf,
  isAbortError,
  type Api,
  type Chart,
  type ChartCreateRequest,
  type ChartResult,
  type FieldError,
  type Report,
} from '../../api';
import { ErrorState } from '../../components/ErrorState';
import { useRequest } from '../../hooks/useRequest';
import { formatDate, formatPosition } from '../../i18n/format';
import { ru } from '../../i18n/ru';
import { botShareLink } from '../../lib/share';
import type { Telegram } from '../../telegram';
import styles from './ChartScreen.module.css';
import { PointCard } from './PointCard';
import { ReportTeaser } from './ReportTeaser';
import { Wheel } from './Wheel';

const copy = ru.chart;
const SKELETON_CARDS = [0, 1, 2];

/** The chart on screen, as the screens that follow it need it: what a purchase and a report are about. */
export interface OpenChart {
  chartId: string;
  /** What the share button sends: the picture and the words. Null when there is no picture to send. */
  share: { url: string; text: string } | null;
}

/** The full report on the chart screen: what the server says the user has, and where the buttons lead. */
export interface ChartReportProps {
  /** `Me.entitlements.full_report`. */
  fullReport: boolean;
  /** `Me.latest_report_id`, or a report met in this session; null when the app knows of none. */
  reportId: string | null;
  /** What the server last said about that report, when the app has already heard it. */
  known?: Report | null;
  /** The server's fresh word about the report. Keep the reference stable: a new function is a new request. */
  onKnown?: (report: Report) => void;
  /** Telegram called the report paid in this visit and the server has not granted it yet: no price is offered meanwhile. */
  paymentPending?: boolean;
  /** Asks the server again whether the payment has arrived. */
  onCheckPayment?: () => Promise<unknown>;
  /** The button under the locked opening: on to the paywall. */
  onBuy: (chart: OpenChart) => void;
  /** The tap that orders the report. */
  onOrder: (chart: OpenChart) => void;
  /** Opens the report the app knows of. */
  onOpen: (chart: OpenChart, reportId: string) => void;
}

export interface ChartScreenProps {
  api: Pick<Api, 'createChart' | 'getCurrentChart' | 'getReport'>;
  telegram: Pick<Telegram, 'isTelegram' | 'close' | 'share'>;
  /**
   * Body of `POST /charts`; null to open the chart the user already has (`GET /charts/current`).
   * Keep the reference stable: a new object is a new request.
   */
  request: ChartCreateRequest | null;
  /** API origin that a relative `wheel_url` resolves against; '' = this page's origin. */
  apiBaseUrl: string;
  /** Username of the bot for the link in a shared message, without `@`; '' = no link. */
  botUsername: string;
  /** Reports the request, its outcome and the tap on «share»; nothing of the chart itself. */
  track: Track;
  back?: ScreenProps['back'];
  /** Leaves for the birth data: to correct what the server rejected, or to build another chart. */
  onEdit: () => void;
  /**
   * The server rejected the request and named the fields (`details.field_errors`).
   * The caller may leave this screen for the one where the field is; if it stays,
   * the error is shown here. Keep the reference stable: a new function is a new request.
   */
  onRejected?: (errors: FieldError[]) => void;
  /**
   * Asked for the chart the user already has, the server has none. The caller leads on to
   * the onboarding. Keep the reference stable: a new function is a new request.
   */
  onMissing?: () => void;
  /**
   * The chart this screen showed on an earlier visit, while it is still the one to show.
   * It is drawn at once: nothing is asked of the server and nothing is counted a second
   * time. Read when the screen opens; a later change of the prop changes nothing.
   */
  cached?: ChartResult | null;
  /** A chart came from the server, not from `cached`. Keep the reference stable: a new function is a new request. */
  onLoaded?: (result: ChartResult) => void;
  /** Where the screen is scrolled to. Kept by the caller, so a return from another screen lands where the user left. */
  scroll?: { current: number };
  /** The full report: the block under the cards. */
  report: ChartReportProps;
  onOpenSettings: () => void;
}

/**
 * Screen 5. Shows a chart: built from the birth data (`POST /charts` is idempotent by
 * input), or the one the user already has. The server hands both over in one envelope.
 */
export function ChartScreen({
  api,
  telegram,
  request,
  apiBaseUrl,
  botUsername,
  track,
  back,
  onEdit,
  onRejected,
  onMissing,
  cached,
  onLoaded,
  scroll,
  report,
  onOpenSettings,
}: ChartScreenProps) {
  const titleId = useId();
  const [remembered] = useState(cached ?? null);
  const load = useCallback(
    async (signal: AbortSignal): Promise<ChartResult | null> => {
      // Shown on an earlier visit: the user came back to the screen, the server is not asked again.
      if (remembered !== null) return remembered;
      if (request === null) {
        const current = await api.getCurrentChart(signal);
        // An answer nobody waits for any more is neither counted nor acted on.
        if (signal.aborted) return current;
        if (current === null) {
          onMissing?.();
        } else {
          track('chart_restored');
          onLoaded?.(current);
        }
        return current;
      }
      // Counted a moment later, and only if still wanted: a development build runs every
      // effect twice and cancels the first run on the spot. That run is not a request the user made.
      void Promise.resolve().then(() => {
        if (!signal.aborted) track('chart_requested');
      });
      try {
        const result = await api.createChart(request, signal);
        // The body, not the status, tells a chart that already existed from a new one.
        if (!signal.aborted) {
          track(result.is_restored ? 'chart_restored' : 'chart_created');
          onLoaded?.(result);
        }
        return result;
      } catch (error) {
        // An answer nobody waits for any more (the screen was left) is neither counted nor acted on.
        if (!signal.aborted && !isAbortError(error)) {
          track('chart_failed', { code: errorCodeOf(error) });
          trackRejection(track, 'chart', error);
          const rejected = fieldErrorsOf(error);
          if (rejected.length > 0) onRejected?.(rejected);
        }
        throw error;
      }
    },
    [api, request, onRejected, onMissing, onLoaded, track, remembered],
  );
  const state = useRequest(load);
  // A remembered chart is on screen from the first frame: there is nothing to wait for.
  const result = remembered ?? (state.status === 'ready' ? state.data : null);
  // An answer without a chart is the caller's cue to lead elsewhere; until it does, the screen keeps waiting.
  const waiting = state.status !== 'error' && result === null;
  // A chart opened from the server has no form behind it: the way to the birth data starts from an empty one.
  const editLabel = request === null ? copy.enterAgain : copy.editData;

  // Back from another screen, the chart is where the user left it, not at its top.
  const body = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const element = body.current;
    if (element === null || scroll === undefined) return undefined;
    if (remembered !== null) element.scrollTop = scroll.current;
    const remember = () => {
      scroll.current = element.scrollTop;
    };
    element.addEventListener('scroll', remember, { passive: true });
    return () => {
      element.removeEventListener('scroll', remember);
    };
  }, [scroll, remembered]);

  return (
    <Screen
      labelledBy={titleId}
      back={back}
      busy={waiting}
      bodyRef={body}
      action={{ label: ru.common.settings, icon: <GearIcon />, onClick: onOpenSettings }}
    >
      <div className={styles.content}>
        <ScreenHeading id={titleId} title={copy.title} text={result ? birthLine(result.chart) : undefined} focusOnMount />
        {waiting && <ChartSkeleton />}
        {state.status === 'error' && (
          <ErrorState error={state.error} telegram={telegram} onRetry={state.retry}>
            <Button variant="secondary" onClick={onEdit}>
              {editLabel}
            </Button>
          </ErrorState>
        )}
        {result && (
          <ChartView
            api={api}
            result={result}
            apiBaseUrl={apiBaseUrl}
            botUsername={botUsername}
            telegram={telegram}
            track={track}
            report={report}
            editLabel={editLabel}
            // After the form the way back to it is the back button; a chart opened at the start has only this one.
            offersEdit={request === null}
            onRetry={state.retry}
            onEdit={onEdit}
          />
        )}
      </div>
    </Screen>
  );
}

/**
 * Whether the chart was built with a birth time. This is about what the chart holds (an
 * Ascendant and houses, or none), not a warning: those come from the server.
 *
 * `birth.time_precision` echoes the request. A chart built before the field existed
 * lacks it; such a chart still tells through `time_known`, or through a null `asc`
 * (without a time the Ascendant is not calculated).
 */
function hasBirthTime({ birth, asc }: Chart): boolean {
  if (birth.time_precision !== undefined) return birth.time_precision !== 'unknown';
  return birth.time_known ?? asc !== null;
}

/** Date · time · place the chart was built from: lets the user spot a typo. */
function birthLine(chart: Chart): string | undefined {
  const { birth } = chart;
  const time = hasBirthTime(chart) ? birth.time : copy.timeUnknown;
  const parts = [birth.date && formatDate(birth.date), time, birth.place?.name].filter(Boolean);
  return parts.length > 0 ? parts.join(' · ') : undefined;
}

function ChartSkeleton() {
  return (
    <SkeletonGroup label={copy.loading} className={styles.content}>
      <Skeleton className={styles.lineSkeleton} />
      <div className={styles.square}>
        <Skeleton variant="circle" className={styles.squareFill} />
      </div>
      <Skeleton variant="block" className={styles.buttonSkeleton} />
      {SKELETON_CARDS.map((card) => (
        <Skeleton key={card} variant="block" className={styles.cardSkeleton} />
      ))}
    </SkeletonGroup>
  );
}

interface ChartViewProps {
  api: Pick<Api, 'getReport'>;
  result: ChartResult;
  apiBaseUrl: string;
  botUsername: string;
  telegram: Pick<Telegram, 'share'>;
  track: Track;
  report: ChartReportProps;
  editLabel: string;
  /** Whether the chart itself offers the way to the birth data, under everything else. */
  offersEdit: boolean;
  onRetry: () => void;
  onEdit: () => void;
}

function ChartView({
  api,
  result,
  apiBaseUrl,
  botUsername,
  telegram,
  track,
  report,
  editLabel,
  offersEdit,
  onRetry,
  onEdit,
}: ChartViewProps) {
  const cardsTitleId = useId();
  const [wheelFailed, setWheelFailed] = useState(false);
  const { chart, mini_reading: reading, warnings, wheel_url: wheelPath, wheel_png_url: wheelPngPath } = result;
  const wheelUrl = wheelPath ? absoluteApiUrl(wheelPath, apiBaseUrl, window.location.origin) : null;
  // What goes to a chat: there a PNG is shown as a picture, an SVG as a bare link.
  // A server older than contract 1.3.0 has only the SVG.
  const wheelPngUrl = wheelPngPath ? absoluteApiUrl(wheelPngPath, apiBaseUrl, window.location.origin) : null;
  // The picture stays the address of the message, so the chat previews it; the way to the bot goes with the words.
  const botLink = botShareLink(botUsername, chart.chart_id);
  const shareUrl = wheelPngUrl ?? wheelUrl;
  const share = shareUrl === null ? null : { url: shareUrl, text: botLink === null ? copy.shareText : `${copy.shareText}\n${botLink}` };
  // What is shared is the picture, from the same server under the same signature: no point in sending one that does not open here.
  const open: OpenChart = { chartId: chart.chart_id, share: wheelFailed ? null : share };
  const sun = chart.planets.find((planet) => planet.key === 'sun');
  const moon = chart.planets.find((planet) => planet.key === 'moon');
  const timeKnown = hasBirthTime(chart);
  const asc = timeKnown ? chart.asc : null;
  const houseOf = (house: number | null | undefined) => (timeKnown && typeof house === 'number' ? copy.house(house) : undefined);

  const hasReading = [reading.sun, reading.moon, reading.asc, reading.summary].some((line) => line !== '');
  if (!sun && !moon && !asc?.sign && !wheelUrl && !hasReading) {
    return (
      <StateView title={copy.emptyTitle} text={copy.emptyText} icon={<InfoIcon />}>
        <Button onClick={onRetry}>{ru.common.retry}</Button>
        <Button variant="secondary" onClick={onEdit}>
          {editLabel}
        </Button>
      </StateView>
    );
  }

  return (
    <>
      {wheelUrl && share ? (
        <>
          <Wheel src={wheelUrl} onFailedChange={setWheelFailed} />
          <Button
            variant="secondary"
            icon={<ShareIcon />}
            disabled={wheelFailed}
            onClick={() => {
              track('share_clicked');
              telegram.share(share.url, share.text);
            }}
          >
            {copy.share}
          </Button>
        </>
      ) : (
        <p className={styles.wheelMissing}>{copy.wheelMissing}</p>
      )}

      {/* What the server says about the input, in its order. The screen adds no warnings of its own. */}
      {warnings.length > 0 && (
        <div className={styles.warnings}>
          {warnings.map((code) => (
            <Notice key={code} tone="warning">
              {copy.warnings[code]}
            </Notice>
          ))}
        </div>
      )}

      <section className={styles.cards} aria-labelledby={cardsTitleId}>
        <VisuallyHidden>
          <h2 id={cardsTitleId}>{copy.cardsTitle}</h2>
        </VisuallyHidden>
        <PointCard
          icon={<SunIcon />}
          title={copy.sun}
          position={sun ? formatPosition(sun.sign, sun.degree, sun.minute) : null}
          fallback={copy.noPosition}
          detail={houseOf(sun?.house)}
          text={reading.sun}
        />
        <PointCard
          icon={<MoonIcon />}
          title={copy.moon}
          position={moon ? formatPosition(moon.sign, moon.degree, moon.minute) : null}
          fallback={copy.noPosition}
          detail={houseOf(moon?.house)}
          text={reading.moon}
        />
        {timeKnown ? (
          <PointCard
            icon={<AscendantIcon />}
            title={copy.asc}
            position={asc?.sign ? formatPosition(asc.sign, asc.degree, asc.minute) : null}
            fallback={copy.noPosition}
            text={reading.asc}
          />
        ) : (
          <PointCard
            icon={<AscendantIcon />}
            title={copy.asc}
            position={null}
            fallback={copy.ascUnknown}
            text={copy.ascUnknownText}
          />
        )}
      </section>

      <ReportTeaser
        api={api}
        chartId={chart.chart_id}
        fullReport={report.fullReport}
        reportId={report.reportId}
        known={report.known}
        onKnown={report.onKnown}
        paymentPending={report.paymentPending}
        onCheckPayment={report.onCheckPayment}
        onBuy={() => {
          report.onBuy(open);
        }}
        onOrder={() => {
          report.onOrder(open);
        }}
        onOpen={(reportId) => {
          report.onOpen(open, reportId);
        }}
      />

      {offersEdit && (
        <Button variant="ghost" onClick={onEdit}>
          {editLabel}
        </Button>
      )}
    </>
  );
}
