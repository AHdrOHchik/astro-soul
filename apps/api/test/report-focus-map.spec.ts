import { describe, expect, it } from 'vitest';
import {
  CHAPTER_FOCUS_MAX,
  CHAPTER_FOCUS_MIN,
  CONTENT_SECTIONS,
  distributeFocuses,
  factorRows,
  focusBlockFor,
} from '../src/modules/reports/focus-map';

/**
 * Распределение `focuses` по главам (итерация 17, задача A).
 *
 * План ниже — тот самый, из-за которого упал живой прогон 16.11.2026: семь
 * тем, каждая глава получала все семь, и модель сжимала их в один абзац.
 */
const LIVE_PLAN = [
  { topic: 'скорость ума', factor: 'Меркурий в Близнецах', angle: 'как быстро он связывает факты' },
  { topic: 'поток информации', factor: 'Меркурий в 11-м доме', angle: 'зачем ему чужие истории' },
  { topic: 'три версии одного ответа', factor: 'Юпитер в Козероге', angle: 'осторожность в выводах' },
  { topic: 'вода 17 %', factor: 'баланс стихий: вода 17 %', angle: 'что даётся дорого' },
  { topic: 'триггер злости', factor: 'Марс в Овне', angle: 'как проявляется раздражение' },
  { topic: 'механизм сарказма', factor: 'Луна в Льве', angle: 'защита через иронию' },
  { topic: 'разрыв с людьми', factor: 'Плутон в 7-м доме', angle: 'почему близко подпускать трудно' },
];

describe('distributeFocuses', () => {
  it('делит план из семи фокусов: каждой главе 2–3, а не все семь', () => {
    const distribution = distributeFocuses(LIVE_PLAN);

    for (const chapter of CONTENT_SECTIONS) {
      expect(distribution.counts[chapter]).toBeGreaterThanOrEqual(CHAPTER_FOCUS_MIN);
      expect(distribution.counts[chapter]).toBeLessThanOrEqual(CHAPTER_FOCUS_MAX);
    }
    expect(distribution.unmapped).toEqual([]);
  });

  it('отдаёт главе фокусы про её факторы: talents получает Меркурий, а не Плутона', () => {
    const distribution = distributeFocuses(LIVE_PLAN);
    const block = focusBlockFor(distribution, 'talents');

    expect(block).toContain('Меркурий');
    expect(block).toContain('Юпитер');
    expect(block).not.toContain('Плутон');
  });

  it('одинаковый план даёт одинаковое распределение', () => {
    const first = distributeFocuses(LIVE_PLAN);
    const second = distributeFocuses(LIVE_PLAN);

    expect(second.counts).toEqual(first.counts);
    for (const chapter of CONTENT_SECTIONS) {
      expect(second.byChapter[chapter].map((focus) => focus.index)).toEqual(
        first.byChapter[chapter].map((focus) => focus.index),
      );
    }
  });

  it('план из двух фокусов не оставляет главу без темы', () => {
    const distribution = distributeFocuses([
      { topic: 'скорость решений', factor: 'Солнце в Тельце' },
      { topic: 'видимость', factor: 'Луна в Льве' },
    ]);

    for (const chapter of CONTENT_SECTIONS) {
      expect(distribution.counts[chapter]).toBeGreaterThanOrEqual(1);
    }
  });

  it('помечает фокусы, которые не привязались к §3', () => {
    const distribution = distributeFocuses([{ topic: 'просто настроение' }, ...LIVE_PLAN]);

    expect(distribution.unmapped).toEqual([0]);
  });
});

describe('factorRows', () => {
  it('различает знак и дом у одной планеты', () => {
    expect(factorRows('Солнце в Тельце')).toEqual(['sun_sign']);
    // Дом добавляет и свою строку карты: «Солнце в 10-м» — это sun_house и house_10.
    expect(factorRows('Солнце в 10-м доме')).toEqual(['sun_house', 'house_10']);
  });

  it('не путает Лунный узел с Луной', () => {
    expect(factorRows('Лунный узел в Стрельце')).toEqual(['node']);
  });

  it('видит аспект как отдельную строку карты', () => {
    // Порядок строк — порядок планет в карте (Плутон раньше Луны), не смысл.
    expect(factorRows('Луна квадрат Плутон')).toEqual(['aspects_outer', 'aspects_moon']);
    expect(factorRows('Солнце трин Уран')).toEqual(['aspects_outer', 'aspects_sun']);
  });

  it('для планеты без отдельной строки в §3 берёт общую', () => {
    // «Меркурий в 11-м доме»: отдельной строки mercury_house в §3 нет,
    // поэтому роль Меркурия (talents — главный) не теряется.
    expect(factorRows('Меркурий в 11-м доме')).toEqual(['mercury', 'house_11']);
  });

  it('узнаёт балансы стихий и крестов', () => {
    expect(factorRows('баланс стихий: вода 17 %')).toEqual(['balances_elements']);
    expect(factorRows('фиксированный крест 45 %')).toEqual(['balances_crosses']);
  });
});
