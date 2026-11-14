import { Button, InfoIcon, Screen, ScreenHeading, ShareIcon, Skeleton, SkeletonGroup, StateView, type ScreenProps } from '@astro-soul/ui';
import { useEffect, useId, useRef } from 'react';
import type { Track } from '../../analytics';
import { failureCodeOf, type Api, type Forecast } from '../../api';
import { ErrorState } from '../../components/ErrorState';
import { SubscriptionHint } from '../../components/SubscriptionHint';
import { ru } from '../../i18n/ru';
import type { Telegram } from '../../telegram';
import styles from './ForecastScreen.module.css';
import { forecastDay, useForecast, type KnownForecast } from './useForecast';

const copy = ru.forecast;
const SKELETON_LINES = [0, 1, 2];

export interface ForecastScreenProps {
  api: Pick<Api, 'getForecast'>;
  telegram: Pick<Telegram, 'isTelegram' | 'close' | 'share' | 'openLink'>;
  /** The chart the forecast is for. */
  chartId: string;
  /** IANA zone of the birth place: «today» is its calendar day, not the device's. Null when the chart names none. */
  timeZone: string | null;
  /** What the app last heard about this forecast: on screen from the first frame, while the server is asked again. */
  known?: KnownForecast | null;
  /** The server's fresh word. Keep the reference stable: a new function is a new request. */
  onKnown?: (chartId: string, forecast: Forecast | null) => void;
  /** What the share button sends: the picture of the chart and the words with it. Never the text of the forecast. */
  share: { url: string; text: string } | null;
  /** The current moment; the device clock unless a test pins it. */
  now?: () => Date;
  track: Track;
  back?: ScreenProps['back'];
  /** On to the question screen. */
  onAsk: () => void;
  /**
   * The quiet way to the subscriptions. Absent where there is none to offer (the user has
   * one, or this build sells none): then nothing under the text speaks of a subscription.
   */
  onSubscribe?: () => void;
  /** Back to the chart. */
  onClose: () => void;
  /**
   * The server has no forecast (404). The contract gives that answer one meaning, «not
   * prepared yet», and this screen shows exactly that; the caller may check on its own
   * that the chart is still there.
   */
  onNotReady?: () => void;
}

/**
 * Screen 8. Shows the forecast the server has prepared: all of the text it gives out, the
 * focus of the day when it names one, and the day the forecast is for.
 *
 * Nothing here asks for a forecast to be made, and nothing waits for one: «not prepared
 * yet» is said once, plainly, with the way back to the chart. Whether the text is the
 * full one is the server's word (`is_paid`); the screen opens and hides nothing itself.
 */
export function ForecastScreen({
  api,
  telegram,
  chartId,
  timeZone,
  known,
  onKnown,
  share,
  now = () => new Date(),
  track,
  back,
  onAsk,
  onSubscribe,
  onClose,
  onNotReady,
}: ForecastScreenProps) {
  const titleId = useId();
  const { view, retry } = useForecast({ api, chartId, known, onKnown });

  // Once per opening of the screen, when there is a forecast to see. The refs keep a development build, which runs effects twice, from counting twice.
  const shown = view.kind === 'ready';
  const viewed = useRef(false);
  useEffect(() => {
    if (!shown || viewed.current) return;
    viewed.current = true;
    track('forecast_view');
  }, [shown, track]);

  // Once per failed attempt.
  const failure = view.kind === 'error' ? view.error : null;
  const reported = useRef<unknown>(null);
  useEffect(() => {
    if (failure === null || reported.current === failure) return;
    reported.current = failure;
    track('error_shown', { screen: 'forecast', code: failureCodeOf(failure) });
  }, [failure, track]);

  // Told when the answer comes, once: nothing here asks again, so «none yet» is not arrived at twice.
  // Through a ref: the caller's function is a new one on every render of its own.
  const pending = view.kind === 'pending';
  const notReady = useRef(onNotReady);
  useEffect(() => {
    notReady.current = onNotReady;
  });
  useEffect(() => {
    if (pending) notReady.current?.();
  }, [pending]);

  if (view.kind === 'loading') {
    return (
      <Screen labelledBy={titleId} back={back} busy>
        <div className={styles.content}>
          <ScreenHeading id={titleId} title={copy.title} focusOnMount />
          <SkeletonGroup label={copy.loading} className={styles.skeleton}>
            {SKELETON_LINES.map((line) => (
              <Skeleton key={line} />
            ))}
          </SkeletonGroup>
        </div>
      </Screen>
    );
  }

  if (view.kind === 'pending') {
    // Not a failure: no alert, no «retry», nothing that counts down. The forecast will be there when the server has written it.
    return (
      <Screen back={back}>
        <StateView icon={<InfoIcon />} title={copy.pendingTitle} text={copy.pendingText} note={copy.pendingNote}>
          <Button onClick={onClose}>{copy.toChart}</Button>
        </StateView>
      </Screen>
    );
  }

  if (view.kind === 'error') {
    // The request failed: said as that, and asked again only by the user's tap.
    return (
      <Screen back={back}>
        <ErrorState error={view.error} telegram={telegram} title={copy.failedTitle} onRetry={retry}>
          <Button variant="secondary" onClick={onClose}>
            {copy.toChart}
          </Button>
        </ErrorState>
      </Screen>
    );
  }

  const { forecast } = view;
  const { today, day } = forecastDay(forecast, timeZone, now());
  return (
    <Screen labelledBy={titleId} back={back} footer={<Button onClick={onAsk}>{copy.ask}</Button>}>
      <div className={styles.content}>
        {/* «Today» only for today's forecast; any other is named by its date, and the date is on screen either way. */}
        <ScreenHeading id={titleId} title={today ? copy.title : copy.titleFor(day)} text={today ? day : undefined} focusOnMount />
        {/* A label next to the text, not a section: only for a focus the server named and this build has a word for. */}
        {forecast.focus !== null && <p className={styles.focus}>{copy.focus(copy.focusNames[forecast.focus])}</p>}
        <p className={styles.text}>{forecast.text}</p>
        {/* Under the short text, never over it and never instead of it. */}
        {!forecast.is_paid && onSubscribe && <SubscriptionHint text={copy.subscriptionOnly} onOpen={onSubscribe} />}
        {share && (
          <Button
            variant="secondary"
            icon={<ShareIcon />}
            onClick={() => {
              track('share_clicked');
              telegram.share(share.url, share.text);
            }}
          >
            {copy.share}
          </Button>
        )}
      </div>
    </Screen>
  );
}
