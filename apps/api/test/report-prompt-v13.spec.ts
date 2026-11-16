import { describe, expect, it } from 'vitest';
import {
  chaptersForFactor,
  focusesForSection,
  MAX_FOCUSES_PER_CHAPTER,
  type PlanFocus,
} from '../src/modules/reports/focus-map';
import { CHAPTER_FORM, chapterPrompt, PROMPT_VERSION, SECTION_RULES } from '../src/modules/reports/prompts';

/**
 * Живой прогон 2026-11-16: план вернул семь фокусов, и каждая глава получала
 * **весь** план. Модель сжимала семь тем в один абзац — валидатор видел
 * `paragraphs: 1 вне 3–6`, а чинить надо было вход.
 */
const SEVEN: readonly PlanFocus[] = [
  { topic: 'скорость решений', factor: 'Солнце в Тельце', angle: 'цена позднего старта' },
  { topic: 'видимость', factor: 'Луна в Льве', angle: 'заметность без позы' },
  { topic: 'речь и счёт', factor: 'Меркурий в Деве', angle: 'точность против темпа' },
  { topic: 'близость', factor: 'Венера в Весах', angle: 'равновесие в паре' },
  { topic: 'напор', factor: 'Марс в Овне', angle: 'сила без давления' },
  { topic: 'опора', factor: 'Сатурн в Козероге', angle: 'терпение как ресурс' },
  { topic: 'направление', factor: 'Узел в Водолее', angle: 'куда тянет' },
];

describe('focus-map: доля плана на главу', () => {
  it('глава получает 1–3 фокуса, а не все семь', () => {
    const total = (['core', 'emotions', 'talents', 'relations', 'money', 'purpose'] as const).map(
      (key) => focusesForSection(SEVEN, key).length,
    );

    for (const count of total) {
      expect(count).toBeGreaterThanOrEqual(1);
      expect(count).toBeLessThanOrEqual(MAX_FOCUSES_PER_CHAPTER);
    }
    // Ни одна глава не получает больше трёх и ни один фокус не дублируется.
    expect(total.reduce((sum, count) => sum + count, 0)).toBeLessThanOrEqual(SEVEN.length);
    expect(total.every((count) => count <= 3)).toBe(true);
  });

  it('раскладка детерминированная: два вызова — один результат', () => {
    const first = ['core', 'emotions', 'talents', 'relations', 'money', 'purpose'].map((key) =>
      focusesForSection(SEVEN, key as 'core').map((focus) => focus.topic),
    );
    const second = ['core', 'emotions', 'talents', 'relations', 'money', 'purpose'].map((key) =>
      focusesForSection(SEVEN, key as 'core').map((focus) => focus.topic),
    );

    expect(first).toEqual(second);
  });

  it('фактор уходит в свою главу по карте structure.md §3', () => {
    expect(chaptersForFactor('Меркурий в Деве')).toEqual(['talents']);
    expect(chaptersForFactor('Венера в Весах')).toEqual(['relations']);
    expect(chaptersForFactor('Луна в Льве')).toEqual(['emotions', 'core']);
    expect(chaptersForFactor('Аспект Луны к Сатурну')).toEqual(['emotions']);
    expect(chaptersForFactor('Стихии и кресты')).toEqual(['core', 'emotions', 'money']);
    expect(chaptersForFactor('десятый дом')).toEqual(['money']);
    expect(chaptersForFactor('совершенно неведомый фактор')).toEqual([]);

    expect(focusesForSection(SEVEN, 'talents').map((focus) => focus.factor)).toEqual(['Меркурий в Деве']);
  });

  it('неопознанный фактор не теряется и не достаётся всем главам', () => {
    const unknown: PlanFocus[] = [{ topic: 'нечто', factor: 'неведомый фактор' }];
    const holders = (['core', 'emotions', 'talents', 'relations', 'money', 'purpose'] as const).filter(
      (key) => focusesForSection(unknown, key).length > 0,
    );

    expect(holders).toHaveLength(1);
  });

  it('пустой план — пустая доля, без падения', () => {
    expect(focusesForSection([], 'talents')).toEqual([]);
  });
});

describe('prompts v1.3: форма текста', () => {
  const form =
    'Форма: 3–6 абзацев, в каждом 2–4 предложения. Одна мысль — один абзац. Не перечисляй темы подряд и не сжимай несколько тем в один абзац: если тем больше, чем абзацев, выбери 2–3 главные и раскрой их, остальные не упоминай.';

  it('версия промптов — одна константа, и она v1.3', () => {
    expect(PROMPT_VERSION).toBe('prompts_v1.3');
    expect(CHAPTER_FORM).toBe(form);
  });

  it('форма попадает в промпт каждой главы', () => {
    for (const key of ['core', 'emotions', 'talents', 'relations', 'money', 'purpose'] as const) {
      const prompt = chapterPrompt({
        key,
        chartFacts: 'chart_facts: v1.2',
        thesis: 'тезис',
        focusBlock: '1. тема',
        previousSummary: 'пока ничего',
        timePrecision: 'exact',
        examples: [],
      });

      expect(prompt).toContain(form);
      expect(prompt).toContain('Фокусы этой главы');
      expect(prompt).not.toContain('Фокусы этого разбора');
    }
  });

  it('тизер core: первые 400 знаков без терминов — правило в промпте', () => {
    expect(SECTION_RULES.core).toContain('В первых 400 знаках ЗАПРЕЩЕНЫ любые астрологические термины');
    expect(SECTION_RULES.core).toContain('«квадрат к Плутону»');
  });
});
