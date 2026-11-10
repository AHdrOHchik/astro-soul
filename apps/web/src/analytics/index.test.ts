import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, type Api } from '../api';
import { cleanProps, MAX_PROP_LENGTH, type ClientEvent, type Track } from './events';
import { createAnalytics, FLUSH_DELAY_MS, flushWhenHidden, MAX_BATCH_SIZE, trackRejection } from './index';

/** The Node process the tests run in. The app's code is typed for a browser, where there is none. */
declare const process: {
  on(event: 'unhandledRejection', listener: (reason: unknown) => void): void;
  off(event: 'unhandledRejection', listener: (reason: unknown) => void): void;
};

const NOW = new Date('2026-11-10T12:00:00.000Z');

function setup(options: { enabled?: boolean } = {}) {
  const sendEvents = vi.fn<Api['sendEvents']>(() => Promise.resolve());
  const analytics = createAnalytics({ api: { sendEvents }, isEnabled: () => options.enabled ?? true, now: () => NOW });
  /** Batches sent so far, as lists of event names. */
  const sent = () => sendEvents.mock.calls.map(([events]) => events.map((event) => event.name));
  return { analytics, sendEvents, sent };
}

/** Collects what `track` is called with, for the helpers that only need the function. */
function recorder() {
  const events: { name: string; props?: object }[] = [];
  const track: Track = (name, ...[props]) => {
    events.push(props === undefined ? { name } : { name, props });
  };
  return { track, events };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createAnalytics', () => {
  it('sends nothing on its own until the events have waited their time', () => {
    const { analytics, sendEvents } = setup();

    analytics.track('app_open');
    analytics.track('screen_view', { step: 'welcome' });
    vi.advanceTimersByTime(FLUSH_DELAY_MS - 1);
    expect(sendEvents).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(sendEvents).toHaveBeenCalledOnce();
    expect(sendEvents).toHaveBeenCalledWith(
      [
        { name: 'app_open', at: '2026-11-10T12:00:00.000Z' },
        { name: 'screen_view', at: '2026-11-10T12:00:00.000Z', props: { step: 'welcome' } },
      ],
      { keepalive: false },
    );
  });

  it(`sends at once when ${String(MAX_BATCH_SIZE)} events are waiting: a batch may not hold more`, () => {
    const { analytics, sendEvents } = setup();

    for (let index = 0; index < MAX_BATCH_SIZE - 1; index += 1) analytics.track('place_search');
    expect(sendEvents).not.toHaveBeenCalled();

    analytics.track('place_search');
    expect(sendEvents).toHaveBeenCalledOnce();
    expect(sendEvents.mock.calls[0]?.[0]).toHaveLength(MAX_BATCH_SIZE);

    // The timer of the batch that left does not fire for an empty queue.
    vi.advanceTimersByTime(FLUSH_DELAY_MS);
    expect(sendEvents).toHaveBeenCalledOnce();
  });

  it('collects nothing when there is nobody to report for', () => {
    const { analytics, sendEvents } = setup({ enabled: false });

    analytics.track('app_open');
    analytics.flush();
    vi.advanceTimersByTime(FLUSH_DELAY_MS);

    expect(sendEvents).not.toHaveBeenCalled();
  });

  it('drops a batch the server did not take and goes on with the next one', async () => {
    // Not a vi.fn(): a mock watches the promises it returns, and a watched rejection is never an unhandled one.
    const batches: string[][] = [];
    const sendEvents: Api['sendEvents'] = (events) => {
      batches.push(events.map((event) => event.name));
      return batches.length === 1 ? Promise.reject(new ApiError('RATE_LIMITED', { status: 429 })) : Promise.resolve();
    };
    const analytics = createAnalytics({ api: { sendEvents }, isEnabled: () => true });
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);

    try {
      analytics.track('app_open');
      await vi.advanceTimersByTimeAsync(FLUSH_DELAY_MS);
      analytics.track('consent_view');
      await vi.advanceTimersByTimeAsync(FLUSH_DELAY_MS);
      // Node reports an unhandled rejection once the turn it happened in is over.
      vi.useRealTimers();
      await new Promise((resolve) => setTimeout(resolve, 0));
    } finally {
      process.off('unhandledRejection', unhandled);
    }

    expect(batches).toEqual([['app_open'], ['consent_view']]);
    expect(unhandled).not.toHaveBeenCalled();
  });

  it('lets no key through that the app does not know, whatever the caller passes', () => {
    const { analytics, sendEvents } = setup();
    const smuggled = { step: 'birth_place', query: 'Казань', birth_date: '1994-05-17', city: 'Казань', lat: 55.79 };

    (analytics.track as (name: string, props: object) => void)('screen_view', smuggled);
    analytics.flush();

    const [event] = sendEvents.mock.calls[0]?.[0] ?? [];
    expect(event).toEqual({ name: 'screen_view', at: NOW.toISOString(), props: { step: 'birth_place' } });
  });
});

describe('cleanProps', () => {
  it.each([
    ['a string longer than the contract allows', 'x'.repeat(MAX_PROP_LENGTH + 1)],
    ['an object', { name: 'Казань' }],
    ['a list', ['a']],
    ['null', null],
    ['undefined', undefined],
    ['not a number', Number.NaN],
    ['infinity', Number.POSITIVE_INFINITY],
  ])('drops %s: one such value makes the server refuse the whole batch', (_label, value) => {
    expect(cleanProps({ step: 'chart', code: value })).toEqual({ step: 'chart' });
  });
});

describe('trackRejection', () => {
  const rejected = (fieldErrors?: unknown) =>
    new ApiError('VALIDATION_FAILED', { status: 422, details: fieldErrors === undefined ? undefined : { field_errors: fieldErrors } });

  it('reports every field the server rejected, once', () => {
    const { track, events } = recorder();

    trackRejection(
      track,
      'chart',
      rejected([
        { field: 'birth_date', message: 'Дата рождения должна быть в прошлом' },
        { field: 'consent.version', message: 'Условия обновились — подтверди согласие ещё раз' },
        { field: 'birth_date', message: 'Разбор доступен с 18 лет' },
      ]),
    );

    expect(events).toEqual([
      { name: 'validation_failed', props: { step: 'chart', code: 'VALIDATION_FAILED', field: 'birth_date' } },
      { name: 'validation_failed', props: { step: 'chart', code: 'VALIDATION_FAILED', field: 'consent.version' } },
    ]);
  });

  it('reports the server text of a field never, and an unknown field as "other"', () => {
    const { track, events } = recorder();

    trackRejection(track, 'birth_place', rejected([{ field: 'Казань', message: 'Введи хотя бы 2 буквы' }]));

    expect(events).toEqual([
      { name: 'validation_failed', props: { step: 'birth_place', code: 'VALIDATION_FAILED', field: 'other' } },
    ]);
    expect(JSON.stringify(events)).not.toMatch(/\p{Script=Cyrillic}/u);
  });
});

describe('flushWhenHidden', () => {
  const hide = () => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
  };

  it('sends what is waiting when the page goes to the background, asking the browser to finish without it', () => {
    const { analytics, sendEvents } = setup();
    const stop = flushWhenHidden(analytics);

    analytics.track('share_clicked');
    hide();

    expect(sendEvents).toHaveBeenCalledOnce();
    expect(sendEvents).toHaveBeenCalledWith([expect.objectContaining<Partial<ClientEvent>>({ name: 'share_clicked' })], {
      keepalive: true,
    });
    stop();
  });

  it('sends the same events once, however many signals of leaving arrive', () => {
    const { analytics, sendEvents } = setup();
    const stop = flushWhenHidden(analytics);

    analytics.track('share_clicked');
    hide();
    window.dispatchEvent(new Event('pagehide'));

    expect(sendEvents).toHaveBeenCalledOnce();
    stop();
  });
});
