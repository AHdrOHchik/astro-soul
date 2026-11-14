import { describe, expect, it } from 'vitest';
import type { Chart } from '@astro-soul/shared';
import { buildDigest } from '../src/modules/reports/digests';
import {
  angleAspects,
  houseRulers,
  serializeAngleAspects,
  serializeChartFactsExtras,
  serializeRulers,
} from '../src/modules/reports/chart-facts-extras';

function makeChart(overrides: Partial<Chart> = {}): Chart {
  return {
    chart_id: '00000000-0000-4000-8000-00000000c0de',
    created_at: '2026-11-10T09:00:00Z',
    birth: { date: '1994-05-17', time: '14:20', time_known: true, time_precision: 'exact' },
    asc: { sign: 'Дева', degree: 15, minute: 3 },
    mc: { sign: 'Телец', degree: 8, minute: 40 },
    planets: [
      { key: 'sun', name: 'Солнце', sign: 'Телец', degree: 26, minute: 17, house: 10, retrograde: false },
      { key: 'moon', name: 'Луна', sign: 'Лев', degree: 12, minute: 38, house: 1, retrograde: false },
      { key: 'mercury', name: 'Меркурий', sign: 'Близнецы', degree: 4, minute: 2, house: 11, retrograde: false },
      { key: 'venus', name: 'Венера', sign: 'Рак', degree: 18, minute: 44, house: 12, retrograde: false },
      { key: 'mars', name: 'Марс', sign: 'Овен', degree: 9, minute: 15, house: 9, retrograde: false },
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
    aspects: [],
    balances: { elements: { fire: 8, earth: 50, air: 22, water: 20 }, modalities: { cardinal: 30, fixed: 45, mutable: 25 } },
    engine_version: '1.0.0',
    omitted_planets: ['chiron'],
    ...overrides,
  } as unknown as Chart;
}

describe('P0-2: аспекты к углам', () => {
  it('планета на Асценденте даёт соединение с силой 1.0', () => {
    const chart = makeChart({
      planets: [
        { key: 'moon', name: 'Луна', sign: 'Дева', degree: 15, minute: 3, house: 1, retrograde: false },
      ],
    } as unknown as Partial<Chart>);

    const aspects = angleAspects(chart);
    expect(aspects[0]).toMatchObject({ planet: 'moon', target: 'asc', type: 'conjunction', strength: 1 });
    expect(serializeAngleAspects(chart)).toContain('Луна соединение ASC 1.0');
  });

  it('планета напротив Асцендента даёт оппозицию, а не квадрат', () => {
    const chart = makeChart({
      planets: [
        { key: 'sun', name: 'Солнце', sign: 'Рыбы', degree: 15, minute: 3, house: 7, retrograde: false },
      ],
    } as unknown as Partial<Chart>);

    // 15°03 Рыб — ровно 180° от Асцендента в Деве.
    const types = angleAspects(chart)
      .filter((aspect) => aspect.target === 'asc')
      .map((aspect) => aspect.type);
    expect(types).toEqual(['opposition']);
  });

  it('при неизвестном времени — пустой массив и пустая строка', () => {
    const chart = makeChart({
      asc: null,
      mc: null,
      houses: null,
      birth: { date: '1994-05-17', time: null, time_known: false, time_precision: 'unknown' },
    } as unknown as Partial<Chart>);

    expect(angleAspects(chart)).toEqual([]);
    expect(serializeAngleAspects(chart)).toBe('');
    expect(serializeRulers(chart)).toBe('');
  });
});

describe('P0-3: управители (современные)', () => {
  it('Асцендент в Деве → Меркурий, дом 11; дома 6/7/10 тоже считаются', () => {
    const rulers = houseRulers(makeChart());
    expect(rulers?.asc).toEqual({ sign: 'Дева', ruler: 'mercury', rulerSign: 'Близнецы', rulerHouse: 11 });
    expect(rulers?.house7?.sign).toBe('Рыбы');
    expect(rulers?.house7?.ruler).toBe('neptune');
    expect(rulers?.house10?.sign).toBe('Близнецы');
    expect(rulers?.house10?.ruler).toBe('mercury');
  });

  it('современные управители: Скорпион — Плутон, Водолей — Уран, Рыбы — Нептун', () => {
    const scorpioAsc = makeChart({ asc: { sign: 'Скорпион', degree: 2, minute: 0 } });
    expect(serializeRulers(scorpioAsc)).toContain('asc Скорпион → pluto');
  });

  it('строка rulers попадает в дополнение к chart_facts', () => {
    const extras = serializeChartFactsExtras(makeChart());
    expect(extras).toContain('rulers: asc Дева → mercury в Близнецы h11');
    expect(extras.split('\n').length).toBeLessThanOrEqual(2);
  });
});

describe('P0-4: сводки глав без LLM', () => {
  it('берёт первое предложение и укладывается в 90 знаков по границе слова', () => {
    const digest = buildDigest(
      'Ты редко торопишься и это не медлительность. Второе длинное предложение про то, ' +
        'как ты проверяешь предложение на прочность перед тем как согласиться. Третье.',
    );
    expect(digest.length).toBeLessThanOrEqual(91);
    expect(digest.startsWith('Ты редко торопишься')).toBe(true);
    expect(digest.endsWith('…') || digest.endsWith('.')).toBe(true);
  });

  it('не режет слово посередине: усечение по пробелу', () => {
    const digest = buildDigest('Первое. ' + 'слово '.repeat(30) + '.');
    expect(digest.endsWith('…')).toBe(true);
    // До многоточия — целое слово, а не его обрывок.
    expect(digest.replace(/…$/u, '')).toMatch(/слово$/u);
  });

  it('одно предложение — просто оно само', () => {
    expect(buildDigest('Короткое предложение.')).toBe('Короткое предложение.');
  });
});
