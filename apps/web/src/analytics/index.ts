import { fieldErrorsOf, isApiError, type Api } from '../api';
import { cleanProps, rejectedFieldOf, type AnalyticsStep, type ClientEvent, type Track } from './events';

export type { AnalyticsStep, EventName, Track } from './events';

/** How long events wait for company before a batch goes out. */
export const FLUSH_DELAY_MS = 3000;
/** The contract's limit for one batch. */
export const MAX_BATCH_SIZE = 20;

export interface Analytics {
  track: Track;
  /** Sends what has been collected, without waiting for the timer. */
  flush(options?: { keepalive?: boolean }): void;
}

export interface AnalyticsOptions {
  api: Pick<Api, 'sendEvents'>;
  /** False when there is nobody to report for: the endpoint takes events only with initData. */
  isEnabled: () => boolean;
  now?: () => Date;
}

/**
 * Product events (`POST /events`): collected in memory, sent in batches, never
 * waited for. A batch goes once: the screens do not care whether it arrived, and a
 * repeated batch would be counted twice. Nothing is kept across restarts.
 */
export function createAnalytics({ api, isEnabled, now = () => new Date() }: AnalyticsOptions): Analytics {
  let queue: ClientEvent[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;

  const flush: Analytics['flush'] = ({ keepalive = false } = {}) => {
    clearTimeout(timer);
    timer = undefined;
    while (queue.length > 0) {
      const batch = queue.slice(0, MAX_BATCH_SIZE);
      queue = queue.slice(MAX_BATCH_SIZE);
      // Neither the answer nor a failure changes anything for the user.
      api.sendEvents(batch, { keepalive }).catch(() => undefined);
    }
  };

  const track: Track = (name, ...[props]) => {
    if (!isEnabled()) return;
    const clean = cleanProps(props);
    queue.push({ name, at: now().toISOString(), ...(clean && { props: clean }) });
    if (queue.length >= MAX_BATCH_SIZE) {
      flush();
      return;
    }
    timer ??= setTimeout(() => {
      flush();
    }, FLUSH_DELAY_MS);
  };

  return { track, flush };
}

/**
 * Sends what is left when the page goes to the background or away: there may be no
 * later. `keepalive` asks the browser to finish the request without the page.
 * Returns the function that stops the watching.
 */
export function flushWhenHidden(analytics: Pick<Analytics, 'flush'>): () => void {
  const onVisibilityChange = () => {
    if (document.visibilityState === 'hidden') analytics.flush({ keepalive: true });
  };
  // Safari before 14.5 does not report the page being closed through `visibilitychange`.
  const onPageHide = () => {
    analytics.flush({ keepalive: true });
  };
  document.addEventListener('visibilitychange', onVisibilityChange);
  window.addEventListener('pagehide', onPageHide);
  return () => {
    document.removeEventListener('visibilitychange', onVisibilityChange);
    window.removeEventListener('pagehide', onPageHide);
  };
}

/** The code an event names a failed request by: the API's or the client's own, never the text. */
export function errorCodeOf(error: unknown): string {
  return isApiError(error) ? error.code : 'UNKNOWN';
}

/**
 * Reports a `VALIDATION_FAILED` answer: one event per field the server named, a
 * single one without a field when it named none. Any other error reports nothing.
 */
export function trackRejection(track: Track, step: AnalyticsStep, error: unknown): void {
  if (!isApiError(error) || error.code !== 'VALIDATION_FAILED') return;
  const fields = new Set(fieldErrorsOf(error).map(({ field }) => rejectedFieldOf(field)));
  if (fields.size === 0) {
    track('validation_failed', { step, code: 'VALIDATION_FAILED' });
    return;
  }
  for (const field of fields) track('validation_failed', { step, code: 'VALIDATION_FAILED', field });
}
