import { describe, expect, it } from 'vitest';
import type { Chart } from '@astro-soul/shared';
import { CHART_FACTS_VERSION, serializeTopFactors, TOP_ASPECTS } from '../src/modules/reports/top-factors';

/**
 * `chart_facts` v1.2 (задача C): в промпт уходят отобранные факторы, а не
 * полная карта. Карта — та же, что в `chart-facts.spec.ts` (вымышленные данные).
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

describe('serializeTopFactors (chart_facts v1.2)', () => {
  it('ровно 7–9 строк в фиксированном порядке', () => {
    const lines = serializeTopFactors(chart).split('\n');

    // 8 строк: заголовок, точность, Солнце, Луна, углы, аспекты, управитель,
    // балансы. Задание допускает 7–9.
    expect(lines).toHaveLength(8);
    expect(lines[0]).toBe(`chart_facts: ${CHART_FACTS_VERSION}`);
    expect(lines[1]).toBe('time_precision: exact');
    expect(lines[2]).toBe("sun|Солнце: Телец 26°17' h10");
    expect(lines[3]).toBe("moon|Луна: Лев 12°38' h1");
    expect(lines[4]).toBe("angles: asc Дева 15°03' | mc Телец 8°40'");
    expect(lines[5]?.startsWith('aspects (3 сильнейших по орбу): ')).toBe(true);
    // Дева → Меркурий, h11: управитель Асцендента и его дом.
    expect(lines[6]).toBe('управитель Асцендента: Меркурий (mercury) в Близнецы, h11');
    expect(lines[7]?.startsWith('balances: ')).toBe(true);
  });

  it('три самых сильных аспекта — по орбу, а не по силе', () => {
    const line = serializeTopFactors(chart)
      .split('\n')
      .find((candidate) => candidate.startsWith('aspects'));

    const parts = line?.replace('aspects (3 сильнейших по орбу): ', '').split(' | ') ?? [];
    expect(parts).toHaveLength(TOP_ASPECTS);
    // Орбы 0.9, 1.1, 1.2 — три самых точных из шести.
    expect(parts[0]).toContain('Венера трин Сатурн');
    expect(parts[1]).toContain('Луна трин Узел');
    expect(parts[2]).toContain('Солнце трин Уран');
    expect(parts[2]).toContain('Телец–Козерог');
  });

  it('одинаковая карта даёт одинаковый вход (порядок не зависит от входа)', () => {
    const shuffled = {
      ...chart,
      aspects: [...chart.aspects].reverse(),
    };

    expect(serializeTopFactors(shuffled)).toBe(serializeTopFactors(chart));
  });

  it('при неизвестном времени нет углов, домов и управителя', () => {
    const unknown = {
      ...chart,
      birth: { ...chart.birth, time: null, time_known: false, time_precision: 'unknown' },
      asc: null,
      mc: null,
      houses: null,
      planets: chart.planets.map((planet) => ({ ...planet, house: null })),
    } as unknown as Chart;

    const text = serializeTopFactors(unknown);
    expect(text).not.toContain('angles');
    expect(text).not.toContain('управитель');
    expect(text).not.toContain('h10');
    expect(text).toContain('time_precision: unknown');
  });

  it('в отборе нет даты, времени и места рождения', () => {
    const text = serializeTopFactors(chart);

    for (const secret of ['1994-05-17', '14:20', 'Москва', '55.75', '37.61', 'Europe/Moscow']) {
      expect(text).not.toContain(secret);
    }
  });

  it('вход заметно короче полной карты', async () => {
    const { serializeChartFacts } = await import('../src/modules/reports/chart-facts');
    const full = serializeChartFacts(chart);
    const top = serializeTopFactors(chart);

    // Критерий приёмки — ≤65 % по токенам; на символах тот же порядок.
    expect(top.length).toBeLessThan(full.length * 0.65);
  });
});
