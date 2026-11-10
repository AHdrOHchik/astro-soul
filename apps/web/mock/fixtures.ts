/*
 * Data for the dev mock of the API. Everything is typed with the types
 * generated from api.openapi.yaml, so the mock cannot drift from the contract:
 * a field the contract does not have fails `pnpm typecheck`.
 *
 * All people-related data is invented. Positions are NOT astronomy: the mock
 * does not calculate anything, and its texts say so.
 */
import type { components, paths } from '../src/api/schema.gen';

type Schemas = components['schemas'];
export type Me = Schemas['Me'];
export type GeoPlace = Schemas['GeoPlace'];
export type Chart = Schemas['Chart'];
export type Problem = Schemas['Problem'];
export type ChartCreateRequest = Schemas['ChartCreateRequest'];
export type ChartCreated = paths['/api/v1/charts']['post']['responses'][201]['content']['application/json'];

export const MOCK_CHART_ID = '00000000-0000-4000-8000-00000000c0de';
const MOCK_SIG = 'mock-signature';

const SIGNS = ['Овен', 'Телец', 'Близнецы', 'Рак', 'Лев', 'Дева', 'Весы', 'Скорпион', 'Стрелец', 'Козерог', 'Водолей', 'Рыбы'];

export const me: Me = {
  user_id: '00000000-0000-4000-8000-000000000001',
  display_name: null,
  is_new: true,
  has_profile: false,
  has_chart: false,
  subscription: { plan: 'none', is_active: false, expires_at: null, auto_renew: false },
  quotas: [],
  onboarding_step: 'birth_date',
};

/** Trigger words for the failure scenarios, see apps/web/README.md. */
export const SCENARIO = {
  serverError: 'Ошибинск',
  rejected: 'Отказово',
  emptyChart: 'Пустошь',
  brokenWheel: 'Безколёсово',
} as const;

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

export function problem(code: Problem['code'], message: string): Problem {
  requestCounter += 1;
  return { code, message, request_id: `mock-${String(requestCounter).padStart(4, '0')}` };
}

/** Demo only: spreads the year evenly over the twelve signs, starting at the March equinox. */
function demoSunSign(isoDate: string): number {
  const [, month = '1', day = '1'] = isoDate.split('-');
  const dayOfYear = (Number(month) - 1) * 30.44 + Number(day);
  return Math.floor((((dayOfYear - 80 + 365.25) % 365.25) / 365.25) * 12);
}

const signAt = (index: number) => SIGNS[((index % 12) + 12) % 12] ?? 'Овен';

export function buildChart(input: ChartCreateRequest): ChartCreated {
  const timeKnown = typeof input.birth_time === 'string';
  const sun = demoSunSign(input.birth_date);
  const house = (value: number) => (timeKnown ? value : null);

  const chart: Chart = {
    chart_id: MOCK_CHART_ID,
    created_at: new Date().toISOString(),
    birth: { date: input.birth_date, time: input.birth_time ?? null, time_known: timeKnown, place: input.birth_place },
    // Contract 1.1.0: without a birth time the Ascendant, the MC and the houses are null.
    asc: timeKnown ? { sign: signAt(sun + 3), degree: 4, minute: 9 } : null,
    mc: timeKnown ? { sign: signAt(sun + 11), degree: 18, minute: 44 } : null,
    planets: [
      { key: 'sun', name: 'Солнце', sign: signAt(sun), degree: 26, minute: 17, house: house(10), retrograde: false },
      { key: 'moon', name: 'Луна', sign: signAt(sun + 5), degree: 3, minute: 42, house: house(3), retrograde: false },
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

  return {
    chart,
    mini_reading: {
      sun: `Демо-текст мока. Солнце в знаке ${signAt(sun)}: здесь будет абзац о характере и о том, что даёт тебе энергию.`,
      moon: `Демо-текст мока. Луна в знаке ${signAt(sun + 5)}: здесь будет абзац об эмоциях и о том, что помогает восстановиться.`,
      ...(timeKnown && {
        asc: `Демо-текст мока. Асцендент в знаке ${signAt(sun + 3)}: здесь будет абзац о первом впечатлении, которое ты производишь.`,
      }),
      summary:
        'Демо-текст мока. Это начало полного разбора: в нём шесть глав — характер, эмоции, таланты, отношения, деньги и предназначение. ' +
        'Каждый вывод опирается на конкретную позицию карты, поэтому текст получается про тебя, а не про знак в целом. ' +
        'Дальше идёт продолжение, которое в приложении скрыто до покупки полного разбора.',
    },
    wheel_url: `charts/${MOCK_CHART_ID}/wheel.svg?sig=${MOCK_SIG}`,
  };
}
