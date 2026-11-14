import { cx, ForwardIcon, Skeleton, VisuallyHidden } from '@astro-soul/ui';
import type { Api, Forecast } from '../../api';
import { ru } from '../../i18n/ru';
import styles from './ForecastCard.module.css';
import { firstSentence, forecastDay, useForecast, type KnownForecast } from './useForecast';

const copy = ru.forecast;

export interface ForecastCardProps {
  api: Pick<Api, 'getForecast'>;
  chartId: string;
  /** IANA zone of the birth place: «today» is its calendar day. Null when the chart names none. */
  timeZone: string | null;
  known?: KnownForecast | null;
  /** Keep the reference stable: a new function is a new request. */
  onKnown?: (chartId: string, forecast: Forecast | null) => void;
  /** The current moment; the device clock unless a test pins it. */
  now?: () => Date;
  /** The tap on the card: on to the forecast screen, whatever the card says. */
  onOpen: () => void;
}

/**
 * The forecast on the chart screen: its first sentence in one line, and the way to the
 * rest. The card is the door to the forecast screen in every state: what is not there
 * yet, or could not be loaded, is said here in a line and there in full.
 */
export function ForecastCard({ api, chartId, timeZone, known, onKnown, now = () => new Date(), onOpen }: ForecastCardProps) {
  const { view } = useForecast({ api, chartId, known, onKnown });
  let title: string = copy.title;
  let line: string | null = null;
  // One line for a forecast; what stands in for one is short and is shown whole.
  let whole = true;
  if (view.kind === 'ready') {
    const { today, day } = forecastDay(view.forecast, timeZone, now());
    if (!today) title = copy.titleFor(day);
    line = firstSentence(view.forecast.text);
    whole = false;
  } else if (view.kind === 'pending') {
    line = `${copy.pendingTitle}. ${copy.pendingText}`;
  } else if (view.kind === 'error') {
    line = copy.failedTitle;
  }

  return (
    <button type="button" className={styles.card} aria-busy={view.kind === 'loading' || undefined} onClick={onOpen}>
      <span className={styles.text}>
        <span className={styles.title}>{title}</span>
        {line === null ? (
          <>
            <Skeleton className={styles.skeleton} />
            <VisuallyHidden>{copy.loading}</VisuallyHidden>
          </>
        ) : (
          <span className={cx(styles.line, whole && styles.whole)}>{line}</span>
        )}
      </span>
      <span className={styles.arrow}>
        <ForwardIcon />
      </span>
    </button>
  );
}
