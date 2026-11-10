/* Shared test doubles. All birth data here is invented. */
import userEvent from '@testing-library/user-event';
import { vi } from 'vitest';
import type { Api, Chart, ChartResult, GeoPlace, Me } from '../api';
import { ApiError, type ApiErrorCode } from '../api';
import type { Telegram } from '../telegram';

/** Local noon: the calendar day is the same in whatever time zone the tests run. */
export const TODAY = new Date(2026, 10, 10, 12);

export const kazan: GeoPlace = {
  name: 'Казань',
  region: 'Татарстан',
  country: 'RU',
  lat: 55.7963,
  lon: 49.1088,
  tz: 'Europe/Moscow',
};

export const kazanka: GeoPlace = {
  name: 'Казанка',
  region: 'Николаевская область',
  country: 'UA',
  lat: 47.8381,
  lon: 32.8236,
  tz: 'Europe/Kyiv',
};

export const me: Me = {
  user_id: '00000000-0000-4000-8000-000000000001',
  display_name: null,
  is_new: true,
  has_profile: false,
  has_chart: false,
  subscription: { plan: 'none', is_active: false, expires_at: null, auto_renew: false },
  quotas: [],
};

export const chart: Chart = {
  chart_id: '00000000-0000-4000-8000-00000000c0de',
  created_at: '2026-11-10T09:00:00Z',
  birth: { date: '1994-05-17', time: '14:30', time_known: true, place: kazan },
  asc: { sign: 'Дева', degree: 4, minute: 9 },
  mc: { sign: 'Близнецы', degree: 18 },
  planets: [
    { key: 'sun', name: 'Солнце', sign: 'Телец', degree: 26, minute: 17, house: 9, retrograde: false },
    { key: 'moon', name: 'Луна', sign: 'Рак', degree: 3, minute: 5, house: 11, retrograde: false },
    { key: 'mercury', name: 'Меркурий', sign: 'Близнецы', degree: 11, minute: 40, house: 10, retrograde: true },
  ],
  houses: [],
  aspects: [],
  balances: {},
};

export const chartResult: ChartResult = {
  chart,
  mini_reading: {
    sun: 'Текст про Солнце.',
    moon: 'Текст про Луну.',
    asc: 'Текст про Асцендент.',
    summary: 'Начало полного разбора.',
  },
  wheel_url: `charts/${chart.chart_id}/wheel.svg?sig=test-signature`,
};

/** The same chart as the API returns it when the birth time is unknown. */
export const chartWithoutTime: ChartResult = {
  chart: {
    ...chart,
    birth: { date: '1994-05-17', time: null, time_known: false, place: kazan },
    asc: {},
    mc: {},
    planets: chart.planets.map((planet) => ({ ...planet, house: null })),
  },
  mini_reading: { sun: 'Текст про Солнце.', moon: 'Текст про Луну.', summary: 'Начало полного разбора.' },
  wheel_url: chartResult.wheel_url,
};

export function apiError(code: ApiErrorCode, info: ConstructorParameters<typeof ApiError>[1] = {}): ApiError {
  return new ApiError(code, info);
}

export function fakeApi() {
  return {
    getMe: vi.fn<Api['getMe']>().mockResolvedValue(me),
    resolveGeo: vi.fn<Api['resolveGeo']>().mockResolvedValue([kazan, kazanka]),
    createChart: vi.fn<Api['createChart']>().mockResolvedValue(chartResult),
  };
}

/** Where the app runs; the methods are always spies. */
type Host = Pick<Telegram, 'isTelegram' | 'initData' | 'hasNativeBackButton'>;

export function fakeTelegram(host: Partial<Host> = {}) {
  return {
    isTelegram: true,
    initData: 'query_id=test',
    hasNativeBackButton: true,
    ...host,
    setBackHandler: vi.fn<Telegram['setBackHandler']>(),
    ready: vi.fn<Telegram['ready']>(),
    share: vi.fn<Telegram['share']>(),
    close: vi.fn<Telegram['close']>(),
  };
}

/** A promise settled by the test, to hold a request "in flight". */
export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * user-event on fake timers, so the search debounce can be stepped through.
 * `shouldAdvanceTime` keeps Testing Library's own polling (findBy*, waitFor) alive.
 */
export function setupUser() {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  return userEvent.setup({ advanceTimers: vi.advanceTimersByTime.bind(vi) });
}
