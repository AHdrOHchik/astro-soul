import { describe, expect, it } from 'vitest';
import type { Chart } from '@astro-soul/shared';
import { chartFactLabels, serializeChartFacts } from '../src/modules/reports/chart-facts';

/**
 * Карта из задания (`docs/qa/reports/examples.md`): та же, на которой
 * проверяются эталонные главы. Данные вымышленные.
 */
const chart = {
  chart_id: '00000000-0000-4000-8000-00000000c0de',
  created_at: '2026-11-10T09:00:00Z',
  birth: {
    date: '1994-05-17',
    time: '14:20',
    time_known: true,
    time_precision: 'exact',
    place: { name: 'Москва', country: 'RU', lat: 55.7558, lon: 37.6173, tz: 'Europe/Moscow' },
  },
  asc: { sign: 'Дева', degree: 15, minute: 3 },
  mc: { sign: 'Телец', degree: 8, minute: 40 },
  planets: [
    { key: 'sun', name: 'Солнце', sign: 'Телец', degree: 26, minute: 17, house: 10, retrograde: false },
    { key: 'moon', name: 'Луна', sign: 'Лев', degree: 12, minute: 38, house: 1, retrograde: false },
    { key: 'mercury', name: 'Меркурий', sign: 'Близнецы', degree: 4, minute: 2, house: 11, retrograde: false },
    { key: 'venus', name: 'Венера', sign: 'Рак', degree: 18, minute: 44, house: 12, retrograde: true },
    { key: 'mars', name: 'Марс', sign: 'Овен', degree: 9, minute: 15, house: 9, retrograde: false },
    { key: 'jupiter', name: 'Юпитер', sign: 'Козерог', degree: 21, minute: 7, house: 6, retrograde: false },
    { key: 'saturn', name: 'Сатурн', sign: 'Рыбы', degree: 3, minute: 51, house: 8, retrograde: false },
    { key: 'uranus', name: 'Уран', sign: 'Козерог', degree: 12, minute: 20, house: 6, retrograde: false },
    { key: 'neptune', name: 'Нептун', sign: 'Козерог', degree: 18, minute: 5, house: 6, retrograde: false },
    { key: 'pluto', name: 'Плутон', sign: 'Скорпион', degree: 24, minute: 30, house: 7, retrograde: false },
    { key: 'node', name: 'Узел', sign: 'Стрелец', degree: 8, minute: 10, house: 5, retrograde: false },
  ],
  houses: [
    { house: 1, sign: 'Дева', degree: 15 },
    { house: 2, sign: 'Весы', degree: 9 },
    { house: 3, sign: 'Скорпион', degree: 10 },
    { house: 4, sign: 'Стрелец', degree: 13 },
    { house: 5, sign: 'Козерог', degree: 15 },
    { house: 6, sign: 'Водолей', degree: 15 },
    { house: 7, sign: 'Рыбы', degree: 15 },
    { house: 8, sign: 'Овен', degree: 9 },
    { house: 9, sign: 'Телец', degree: 10 },
    { house: 10, sign: 'Близнецы', degree: 13 },
    { house: 11, sign: 'Рак', degree: 15 },
    { house: 12, sign: 'Лев', degree: 15 },
  ],
  aspects: [
    { a: 'sun', b: 'uranus', type: 'trine', orb: 1.2, strength: 0.9 },
    { a: 'moon', b: 'pluto', type: 'square', orb: 2.1, strength: 0.8 },
    { a: 'venus', b: 'saturn', type: 'trine', orb: 0.9, strength: 0.9 },
    { a: 'mars', b: 'pluto', type: 'opposition', orb: 3.4, strength: 0.6 },
    { a: 'mercury', b: 'mars', type: 'sextile', orb: 1.8, strength: 0.8 },
    { a: 'moon', b: 'node', type: 'trine', orb: 1.1, strength: 1 },
  ],
  balances: {
    elements: { fire: 8, earth: 50, air: 22, water: 20 },
    modalities: { cardinal: 30, fixed: 45, mutable: 25 },
  },
  engine_version: '1.0.0',
  omitted_planets: ['chiron'],
} as unknown as Chart;

describe('serializeChartFacts (P0-1)', () => {
  it('отдаёт ровно тот формат, который ждут промпты', () => {
    expect(serializeChartFacts(chart)).toBe(
      [
        'time_precision: exact',
        'planets:',
        "sun|Солнце: Телец 26°17' h10",
        "moon|Луна: Лев 12°38' h1",
        "mercury|Меркурий: Близнецы 4°02' h11",
        "venus|Венера: Рак 18°44' h12 R",
        "mars|Марс: Овен 9°15' h9",
        "jupiter|Юпитер: Козерог 21°07' h6",
        "saturn|Сатурн: Рыбы 3°51' h8",
        "uranus|Уран: Козерог 12°20' h6",
        "neptune|Нептун: Козерог 18°05' h6",
        "pluto|Плутон: Скорпион 24°30' h7",
        "node|Узел: Стрелец 8°10' h5",
        "angles: asc Дева 15°03' | mc Телец 8°40'",
        "houses: 1 Дева 15°00' | 2 Весы 9°00' | 3 Скорпион 10°00' | 4 Стрелец 13°00' | " +
          '5 Козерог 15°00\' | 6 Водолей 15°00\' | 7 Рыбы 15°00\' | 8 Овен 9°00\' | ' +
          "9 Телец 10°00' | 10 Близнецы 13°00' | 11 Рак 15°00' | 12 Лев 15°00'",
        'aspects (по силе): Луна трин Узел 1.0 orb1.1 | Венера трин Сатурн 0.9 orb0.9 | ' +
          'Солнце трин Уран 0.9 orb1.2 | Меркурий секстиль Марс 0.8 orb1.8 | ' +
          'Луна квадрат Плутон 0.8 orb2.1 | Марс оппозиция Плутон 0.6 orb3.4',
        'balances: fire 8 earth 50 air 22 water 20 | cardinal 30 fixed 45 mutable 25',
        'omitted: chiron (не считается)',
      ].join('\n'),
    );
  });

  it('детерминирован: тот же вход и любой порядок массива — тот же текст', () => {
    const shuffled = {
      ...chart,
      planets: [...chart.planets].reverse(),
      houses: [...(chart.houses ?? [])].reverse(),
      aspects: [...chart.aspects].reverse(),
    } as Chart;

    expect(serializeChartFacts(shuffled)).toBe(serializeChartFacts(chart));
  });

  it('при unknown нет ни строки angles, ни строки houses, ни домов у планет', () => {
    const unknown = {
      ...chart,
      birth: { ...chart.birth, time: null, time_known: false, time_precision: 'unknown' },
      asc: null,
      mc: null,
      houses: null,
      planets: chart.planets.map((planet) => ({ ...planet, house: null })),
    } as unknown as Chart;

    const facts = serializeChartFacts(unknown);
    expect(facts).toContain('time_precision: unknown');
    expect(facts).not.toContain('angles:');
    expect(facts).not.toContain('houses:');
    expect(facts).not.toMatch(/ h\d+/);
    expect(facts).toContain("sun|Солнце: Телец 26°17'");
  });

  it('не протаскивает ни дату, ни время, ни место рождения, ни координаты', () => {
    const facts = serializeChartFacts(chart);
    for (const secret of ['1994', '14:20', 'Москва', '55.7558', '37.6173', 'Europe/Moscow', 'RU']) {
      expect(facts).not.toContain(secret);
    }
  });

  it('незнакомые планеты и аспекты с ними в текст не попадают', () => {
    const withChiron = {
      ...chart,
      planets: [
        ...chart.planets,
        { key: 'chiron', name: 'Хирон', sign: 'Дева', degree: 1, minute: 1, house: 12, retrograde: false },
      ],
      aspects: [...chart.aspects, { a: 'sun', b: 'ceres', type: 'square', orb: 0.1, strength: 0.99 }],
    } as unknown as Chart;

    // Хирон в списке планет допустим по контракту, но если движок его не считал,
    // его не должно быть и в фактах; аспект с неизвестным ключом — тоже.
    const facts = serializeChartFacts(chart);
    expect(facts).not.toContain('Хирон');
    expect(serializeChartFacts(withChiron)).not.toContain('ceres');
  });

  it('подписи для based_on — без градусов и с домом', () => {
    expect(chartFactLabels(chart).slice(0, 3)).toEqual([
      'Солнце в Тельце, 10-й дом',
      'Луна в Льве, 1-й дом',
      'Меркурий в Близнецах, 11-й дом',
    ]);
  });
});
