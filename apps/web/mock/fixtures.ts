/*
 * Data for the dev mock of the API. Everything is typed with the types
 * generated from api.openapi.yaml, so the mock cannot drift from the contract:
 * a field the contract does not have fails `pnpm typecheck`.
 *
 * All people-related data is invented. Positions are NOT astronomy: the mock
 * does not calculate anything. Its wheel says MOCK in the middle, and the chart
 * names `mock` as its engine version.
 */
import type { components } from '../src/api/schema.gen';

type Schemas = components['schemas'];
export type Me = Schemas['Me'];
export type GeoPlace = Schemas['GeoPlace'];
export type Chart = Schemas['Chart'];
export type Problem = Schemas['Problem'];
export type FieldError = Schemas['FieldError'];
export type ChartCreateRequest = Schemas['ChartCreateRequest'];
export type ChartResponse = Schemas['ChartResponse'];
export type EventsAccepted = Schemas['EventsAccepted'];

export const MOCK_CHART_ID = '00000000-0000-4000-8000-00000000c0de';

/**
 * The version of the legal texts the mock accepts in `consent.version` unless it is told
 * another one (API_MOCK_CONSENT_VERSION): the version of the app's own texts, as on a
 * server released together with this front. A server has its own copy of this constant,
 * and so does the mock; tests/mock-api.test.ts keeps it equal to the app's CONSENT_VERSION.
 */
export const MOCK_CONSENT_VERSION = '2026-11-10';
const MOCK_SIG = 'mock-signature';

const SIGNS = ['Овен', 'Телец', 'Близнецы', 'Рак', 'Лев', 'Дева', 'Весы', 'Скорпион', 'Стрелец', 'Козерог', 'Водолей', 'Рыбы'];

/** `GET /me` for a user with the chart `chartId`, or with none yet. */
export function buildMe(chartId: string | null): Me {
  const hasChart = chartId !== null;
  return {
    user_id: '00000000-0000-4000-8000-000000000001',
    display_name: null,
    is_new: !hasChart,
    has_profile: hasChart,
    has_chart: hasChart,
    chart_id: chartId,
    subscription: { plan: 'none', is_active: false, expires_at: null, auto_renew: false },
    quotas: [],
    onboarding_step: hasChart ? 'done' : 'birth_date',
  };
}

/** Places that trigger the scenarios of `POST /charts`, see apps/web/README.md. */
export const SCENARIO = {
  serverError: 'Ошибинск',
  rejectedPlace: 'Отказово',
  rejectedDate: 'Датино',
  rejectedTime: 'Времянск',
  rejectedConsent: 'Согласово',
  outdatedConsent: 'Версионово',
  emptyChart: 'Пустошь',
  brokenWheel: 'Безколёсово',
  approximatePlace: 'Примерново',
} as const;

/** The birth data of the chart a `returning` user of the mock already has. Invented, like everything here. */
export const RETURNING_INPUT: ChartCreateRequest = {
  birth_date: '1994-05-17',
  birth_time: '14:30',
  time_precision: 'exact',
  birth_place: { name: 'Казань', region: 'Татарстан', country: 'RU', lat: 55.7963, lon: 49.1088, tz: 'Europe/Moscow' },
  consent: { accepted: true, version: MOCK_CONSENT_VERSION },
};

/** What makes two requests the same chart: the birth data, as in the server's input hash. The consent is not a part of it. */
export function inputKey({ birth_date, birth_time, time_precision, birth_place }: ChartCreateRequest): string {
  const { name, country, lat, lon, tz } = birth_place;
  return JSON.stringify([birth_date, birth_time ?? null, time_precision, name, country, lat, lon, tz]);
}

/**
 * `ChartResponse.warnings` by the server's rule (apps/api, `computeWarnings`): the time first,
 * then the place. The server warns about a place its gazetteer lacks; here that is one
 * scenario place. That place also gets a code no build knows, to show that the app skips it.
 */
function warningsFor(input: ChartCreateRequest): ChartResponse['warnings'] {
  const warnings: ChartResponse['warnings'] = [];
  if (input.time_precision === 'unknown') warnings.push('no_birth_time');
  if (input.time_precision === 'approximate') warnings.push('approximate_time');
  if (input.birth_place.name === SCENARIO.approximatePlace) {
    // On purpose more than the contract lists: the list is open, and a newer server may send a code like this.
    warnings.push('approximate_place', 'mock_code_of_a_newer_server' as ChartResponse['warnings'][number]);
  }
  return warnings;
}

const scenarioPlace = (name: string): GeoPlace => ({
  name,
  region: 'тестовый сценарий мока',
  country: 'RU',
  lat: 0,
  lon: 0,
  tz: 'Etc/UTC',
});

const PLACES: GeoPlace[] = [
  { name: 'Москва', region: null, country: 'RU', lat: 55.7558, lon: 37.6173, tz: 'Europe/Moscow' },
  { name: 'Москва', region: 'Айдахо', country: 'US', lat: 46.7324, lon: -117.0002, tz: 'America/Los_Angeles' },
  { name: 'Мосальск', region: 'Калужская область', country: 'RU', lat: 54.4925, lon: 34.9856, tz: 'Europe/Moscow' },
  { name: 'Санкт-Петербург', region: null, country: 'RU', lat: 59.9343, lon: 30.3351, tz: 'Europe/Moscow' },
  { name: 'Казань', region: 'Татарстан', country: 'RU', lat: 55.7963, lon: 49.1088, tz: 'Europe/Moscow' },
  { name: 'Новосибирск', region: 'Новосибирская область', country: 'RU', lat: 55.0084, lon: 82.9357, tz: 'Asia/Novosibirsk' },
  { name: 'Екатеринбург', region: 'Свердловская область', country: 'RU', lat: 56.8389, lon: 60.6057, tz: 'Asia/Yekaterinburg' },
  { name: 'Владивосток', region: 'Приморский край', country: 'RU', lat: 43.1155, lon: 131.8855, tz: 'Asia/Vladivostok' },
  { name: 'Калининград', region: 'Калининградская область', country: 'RU', lat: 54.7104, lon: 20.4522, tz: 'Europe/Kaliningrad' },
  { name: 'Алматы', region: null, country: 'KZ', lat: 43.2389, lon: 76.8897, tz: 'Asia/Almaty' },
  { name: 'Минск', region: null, country: 'BY', lat: 53.9006, lon: 27.559, tz: 'Europe/Minsk' },
  { name: 'Амстердам', region: 'Северная Голландия', country: 'NL', lat: 52.3676, lon: 4.9041, tz: 'Europe/Amsterdam' },
  ...Object.values(SCENARIO).map(scenarioPlace),
];

export function findPlaces(query: string, limit: number): GeoPlace[] {
  const needle = query.trim().toLowerCase();
  return PLACES.filter((place) => place.name.toLowerCase().startsWith(needle)).slice(0, limit);
}

let requestCounter = 0;

export function problem(code: Problem['code'], message: string, details?: Problem['details']): Problem {
  requestCounter += 1;
  return { code, message, request_id: `mock-${String(requestCounter).padStart(4, '0')}`, ...(details && { details }) };
}

/** Demo only: spreads the year evenly over the twelve signs, starting at the March equinox. */
function demoSunSign(isoDate: string): number {
  const [, month = '1', day = '1'] = isoDate.split('-');
  const dayOfYear = (Number(month) - 1) * 30.44 + Number(day);
  return Math.floor((((dayOfYear - 80 + 365.25) % 365.25) / 365.25) * 12);
}

const signAt = (index: number) => SIGNS[((index % 12) + 12) % 12] ?? 'Овен';

/** A position the way the API words it in `mini_reading`: sign, degrees, minutes of arc. */
const positionLabel = ({ sign, degree, minute }: { sign: string; degree: number; minute: number }) =>
  `${sign}, ${String(degree)}°${String(minute).padStart(2, '0')}′`;

export function buildChart(input: ChartCreateRequest): ChartResponse {
  const timeKnown = input.time_precision !== 'unknown';
  const sun = demoSunSign(input.birth_date);
  const house = (value: number) => (timeKnown ? value : null);
  const sunPosition = { sign: signAt(sun), degree: 26, minute: 17 };
  const moonPosition = { sign: signAt(sun + 5), degree: 3, minute: 42 };
  const asc = timeKnown ? { sign: signAt(sun + 3), degree: 4, minute: 9 } : null;

  const chart: Chart = {
    chart_id: MOCK_CHART_ID,
    created_at: new Date().toISOString(),
    birth: {
      date: input.birth_date,
      time: timeKnown ? (input.birth_time ?? null) : null,
      time_known: timeKnown,
      time_precision: input.time_precision,
      place: input.birth_place,
    },
    // Without a birth time the Ascendant, the MC and the houses are null.
    asc,
    mc: timeKnown ? { sign: signAt(sun + 11), degree: 18, minute: 44 } : null,
    planets: [
      { key: 'sun', name: 'Солнце', ...sunPosition, house: house(10), retrograde: false },
      { key: 'moon', name: 'Луна', ...moonPosition, house: house(3), retrograde: false },
      { key: 'mercury', name: 'Меркурий', sign: signAt(sun + 1), degree: 11, minute: 5, house: house(11), retrograde: true },
      { key: 'venus', name: 'Венера', sign: signAt(sun - 1), degree: 19, minute: 30, house: house(9), retrograde: false },
      { key: 'mars', name: 'Марс', sign: signAt(sun + 7), degree: 7, minute: 58, house: house(5), retrograde: false },
    ],
    houses: timeKnown ? SIGNS.map((_, index) => ({ house: index + 1, sign: signAt(sun + 3 + index), degree: 4 })) : null,
    aspects: [{ a: 'sun', b: 'moon', type: 'trine', orb: 0.41, strength: 0.9 }],
    balances: {
      // Percentages; each group adds up to 100.
      elements: { fire: 20, earth: 40, air: 20, water: 20 },
      modalities: { cardinal: 30, fixed: 40, mutable: 30 },
    },
    engine_version: 'mock',
  };

  // The same lines as apps/api builds today (`buildMiniReading`): positions as text, no interpretation yet.
  const lines = {
    sun: `Солнце в ${positionLabel(sunPosition)}`,
    moon: `Луна в ${positionLabel(moonPosition)}`,
    asc: asc ? `Асцендент в ${positionLabel(asc)}` : 'Время рождения неизвестно — Асцендент не рассчитан',
  };

  return {
    chart,
    mini_reading: { ...lines, summary: [lines.sun, lines.moon, lines.asc].join(' · ') },
    // One signature for both addresses, as in apps/api: the SVG is for the screen, the PNG for sharing.
    wheel_url: `/api/v1/charts/${MOCK_CHART_ID}/wheel.svg?sig=${MOCK_SIG}`,
    wheel_png_url: `/api/v1/charts/${MOCK_CHART_ID}/wheel.png?sig=${MOCK_SIG}`,
    warnings: warningsFor(input),
    is_restored: false,
  };
}
