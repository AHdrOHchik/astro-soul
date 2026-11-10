import {
  AscendantIcon,
  Button,
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
import { useCallback, useId, useState } from 'react';
import {
  absoluteApiUrl,
  fieldErrorsOf,
  type Api,
  type Chart,
  type ChartCreateRequest,
  type ChartResult,
  type FieldError,
  type TimePrecision,
} from '../../api';
import { ErrorState } from '../../components/ErrorState';
import { useRequest } from '../../hooks/useRequest';
import { formatDate, formatPosition } from '../../i18n/format';
import { ru } from '../../i18n/ru';
import type { Telegram } from '../../telegram';
import styles from './ChartScreen.module.css';
import { PointCard } from './PointCard';
import { Teaser } from './Teaser';
import { Wheel } from './Wheel';

const copy = ru.chart;
const SKELETON_CARDS = [0, 1, 2];

export interface ChartScreenProps {
  api: Pick<Api, 'createChart'>;
  telegram: Pick<Telegram, 'isTelegram' | 'close' | 'share'>;
  /** Body of `POST /charts`. Keep the reference stable: a new object is a new request. */
  request: ChartCreateRequest;
  /** API origin that a relative `wheel_url` resolves against; '' = this page's origin. */
  apiBaseUrl: string;
  back?: ScreenProps['back'];
  /** Return to the birth data, e.g. after the server rejected it. */
  onEdit: () => void;
  /**
   * The server rejected the request and named the fields (`details.field_errors`).
   * The caller may leave this screen for the one where the field is; if it stays,
   * the error is shown here. Keep the reference stable: a new function is a new request.
   */
  onRejected?: (errors: FieldError[]) => void;
}

/** Screen 5. Builds the chart (`POST /charts` is idempotent by input) and shows it. */
export function ChartScreen({ api, telegram, request, apiBaseUrl, back, onEdit, onRejected }: ChartScreenProps) {
  const titleId = useId();
  const load = useCallback(
    async (signal: AbortSignal) => {
      try {
        return await api.createChart(request, signal);
      } catch (error) {
        const rejected = fieldErrorsOf(error);
        // An answer nobody waits for any more (the screen was left) must not move the user anywhere.
        if (rejected.length > 0 && !signal.aborted) onRejected?.(rejected);
        throw error;
      }
    },
    [api, request, onRejected],
  );
  const state = useRequest(load);

  return (
    <Screen labelledBy={titleId} back={back} busy={state.status === 'loading'}>
      <div className={styles.content}>
        <ScreenHeading
          id={titleId}
          title={copy.title}
          text={state.status === 'ready' ? birthLine(state.data.chart) : undefined}
          focusOnMount
        />
        {state.status === 'loading' && <ChartSkeleton />}
        {state.status === 'error' && (
          <ErrorState error={state.error} telegram={telegram} onRetry={state.retry}>
            <Button variant="secondary" onClick={onEdit}>
              {copy.editData}
            </Button>
          </ErrorState>
        )}
        {state.status === 'ready' && (
          <ChartView
            result={state.data}
            apiBaseUrl={apiBaseUrl}
            telegram={telegram}
            onRetry={state.retry}
            onEdit={onEdit}
          />
        )}
      </div>
    </Screen>
  );
}

/**
 * How well the birth time behind the chart is known; null when the chart does not say.
 *
 * `birth.time_precision` echoes the request. A chart built before the field existed
 * lacks it; such a chart still tells whether there was a time at all: `time_known`,
 * or a null `asc` (without a time the Ascendant is not calculated), but not how
 * exact that time was.
 */
function timePrecisionOf({ birth, asc }: Chart): TimePrecision | null {
  if (birth.time_precision !== undefined) return birth.time_precision;
  return (birth.time_known ?? asc !== null) ? null : 'unknown';
}

/** Date · time · place the chart was built from: lets the user spot a typo. */
function birthLine(chart: Chart): string | undefined {
  const { birth } = chart;
  const time = timePrecisionOf(chart) === 'unknown' ? copy.timeUnknown : birth.time;
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
  result: ChartResult;
  apiBaseUrl: string;
  telegram: Pick<Telegram, 'share'>;
  onRetry: () => void;
  onEdit: () => void;
}

function ChartView({ result, apiBaseUrl, telegram, onRetry, onEdit }: ChartViewProps) {
  const cardsTitleId = useId();
  const [wheelFailed, setWheelFailed] = useState(false);
  const { chart, mini_reading: reading, wheel_url: wheelPath } = result;
  const wheelUrl = wheelPath ? absoluteApiUrl(wheelPath, apiBaseUrl, window.location.origin) : null;
  const sun = chart.planets.find((planet) => planet.key === 'sun');
  const moon = chart.planets.find((planet) => planet.key === 'moon');
  const precision = timePrecisionOf(chart);
  const timeKnown = precision !== 'unknown';
  const asc = timeKnown ? chart.asc : null;
  const houseOf = (house: number | null | undefined) => (timeKnown && typeof house === 'number' ? copy.house(house) : undefined);
  // Positions come with minutes of arc either way; say plainly when the input does not support that precision.
  let accuracyNote: string | null = null;
  if (precision === 'unknown') accuracyNote = copy.unknownTime;
  else if (precision === 'approximate') accuracyNote = copy.approxTime;

  const hasReading = [reading.sun, reading.moon, reading.asc, reading.summary].some((line) => line !== '');
  if (!sun && !moon && !asc?.sign && !wheelUrl && !hasReading) {
    return (
      <StateView title={copy.emptyTitle} text={copy.emptyText} icon={<InfoIcon />}>
        <Button onClick={onRetry}>{ru.common.retry}</Button>
        <Button variant="secondary" onClick={onEdit}>
          {copy.editData}
        </Button>
      </StateView>
    );
  }

  return (
    <>
      {wheelUrl ? (
        <>
          <Wheel src={wheelUrl} onFailedChange={setWheelFailed} />
          <Button
            variant="secondary"
            icon={<ShareIcon />}
            // What is shared is the link to this picture: no point in sending one that does not open here.
            disabled={wheelFailed}
            onClick={() => {
              telegram.share(wheelUrl, copy.shareText);
            }}
          >
            {copy.share}
          </Button>
        </>
      ) : (
        <p className={styles.wheelMissing}>{copy.wheelMissing}</p>
      )}

      {accuracyNote && <Notice tone="warning">{accuracyNote}</Notice>}

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

      <Teaser summary={reading.summary} />
    </>
  );
}
