import { describe, expect, it } from 'vitest';
import {
  DISCLAIMER,
  maxOverlap,
  overlapRatio,
  splitSentences,
  validateSection,
} from '../src/modules/reports/validators';

/** Тело нужной длины, чтобы проверка объёма не мешала остальным правилам. */
function body(text: string, key: 'core' | 'summary' = 'core'): string {
  const target = key === 'core' ? 1_300 : 650;
  const filler = ' Это предложение нужно только для длины и ничего не проверяет.';
  let result = text;
  while (result.length < target) {
    result += filler;
  }
  return result;
}

function rules(text: string, precision: 'exact' | 'approximate' | 'unknown' = 'unknown', key: 'core' | 'summary' = 'core') {
  return validateSection({ key, bodyMd: body(text, key), timePrecision: precision });
}

function failed(text: string, precision: 'exact' | 'unknown' = 'unknown', key: 'core' | 'summary' = 'core'): string[] {
  return rules(text, precision, key).failures.map((failure) => failure.rule);
}

/**
 * Семь тест-кейсов из `backend-requests.md` §1.1 — их отсутствие было
 * отдельным требованием к P0-5.
 */
describe('P0-5: дома при unknown — семь обязательных кейсов', () => {
  it('«дома», «домой» — исключения, PASS', () => {
    expect(failed('У тебя дома всегда порядок, а домой ты едешь отдыхать')).toEqual([]);
  });

  it('«доминирующая стихия» — исключение, PASS', () => {
    expect(failed('Доминирующая стихия — земля, поэтому старт дорогой')).toEqual([]);
  });

  it('честная оговорка о неполноте — PASS', () => {
    expect(failed('Время рождения неизвестно, поэтому здесь нет домов и Асцендента')).toEqual([]);
  });

  it('«в десятом доме» — hard fail', () => {
    expect(failed('В десятом доме у тебя Солнце')).toContain('unknown_house');
  });

  it('«в седьмом доме» — hard fail по порядковому числительному', () => {
    expect(failed('В седьмом доме — Скорпион')).toContain('unknown_house');
  });

  it('«в доме партнёрства» — warning, не провал', () => {
    const result = rules('Плутон стоит в доме партнёрства');
    expect(result.failures).toEqual([]);
    expect(result.warnings.some((warning) => warning.startsWith('unknown_house_soft'))).toBe(true);
  });

  it('при exact проверка домов не применяется', () => {
    expect(failed('В десятом доме у тебя Солнце', 'exact')).toEqual([]);
  });
});

describe('P0-5: остальные правила', () => {
  it('вторая оговорка — warning «модель оправдывается»', () => {
    const result = rules(
      'Время рождения неизвестно, поэтому здесь нет домов и Асцендента. ' +
        'Асцендент не рассчитан, поэтому домов и углов в разборе нет.',
    );
    expect(result.warnings.some((warning) => warning.startsWith('unknown_disclaimers'))).toBe(true);
  });

  it('«вы» в любом регистре — провал', () => {
    expect(failed('Вы знаете себя лучше, чем кажется.')).toContain('voice');
    expect(failed('Ваш характер сложнее, чем кажется.')).toContain('voice');
  });

  it('H1, таблица, ссылка, HTML и список не маркером «—» — провал', () => {
    expect(failed('# Ядро личности')).toContain('format_h1');
    expect(failed('Текст | колонка')).toContain('format_table');
    expect(failed('Смотри https://example.com')).toContain('format_link');
    expect(failed('<b>важно</b>')).toContain('format_html');
    expect(failed('- первый пункт')).toContain('format_list');
    // Маркер «—» допустим.
    expect(failed('— первый пункт')).not.toContain('format_list');
  });

  it('запрещённые темы ловятся, включая отрицание', () => {
    expect(failed('Это кармическая история.')).toContain('forbidden_esoterics');
    expect(failed('Это не про предназначение.')).toContain('forbidden_destiny_words');
    expect(failed('В прошлой жизни ты был учителем.')).toContain('forbidden_esoterics');
    expect(failed('Тебе грозит выгорание.')).toContain('forbidden_fear');
    expect(failed('Это влияет на здоровье.')).toContain('forbidden_health');
  });

  it('Хирон — провал: его нет в карте', () => {
    expect(failed('Хирон в Деве добавляет точности.')).toContain('chiron');
  });

  it('объём: выход за границы более чем на 30 % — провал, 10–30 % — предупреждение', () => {
    const long = validateSection({ key: 'purpose', bodyMd: 'а'.repeat(1_250 * 1.31), timePrecision: 'exact' });
    expect(long.failures.map((failure) => failure.rule)).toContain('length');

    const slightlyLong = validateSection({
      key: 'purpose',
      bodyMd: `${'а'.repeat(1_250)} ${'б'.repeat(150)}`,
      timePrecision: 'exact',
    });
    expect(slightlyLong.failures).toEqual([]);
    expect(slightlyLong.warnings.some((warning) => warning.startsWith('length_off'))).toBe(true);
  });

  it('пересечение по 8-граммам больше 12 % — провал', () => {
    const previous =
      'Ты редко торопишься и это не медлительность а способ не вкладываться в то что через месяц окажется пустым.';
    const repeated =
      'Ты редко торопишься и это не медлительность а способ не вкладываться в то что через месяц окажется пустым.';

    expect(overlapRatio(repeated, previous)).toBeGreaterThan(0.12);
    expect(maxOverlap(repeated, [previous])).toBeGreaterThan(0.12);

    const result = validateSection({
      key: 'core',
      bodyMd: body(repeated),
      timePrecision: 'exact',
      previous: [previous],
    });
    expect(result.failures.map((failure) => failure.rule)).toContain('repeats');
  });

  it('в «Итоге» обязателен дисклеймер дословно', () => {
    expect(failed('Делай три вещи.', 'exact', 'summary')).toContain('disclaimer');
    const withDisclaimer = validateSection({
      key: 'summary',
      bodyMd: body(`Делай три вещи. ${DISCLAIMER}`, 'summary'),
      timePrecision: 'exact',
    });
    expect(withDisclaimer.failures.map((failure) => failure.rule)).not.toContain('disclaimer');
  });

  it('слишком короткое тело — провал без обсуждения', () => {
    const result = validateSection({ key: 'core', bodyMd: 'Коротко.', timePrecision: 'exact' });
    expect(result.failures.map((failure) => failure.rule)).toContain('too_short');
  });

  it('делит текст на предложения', () => {
    expect(splitSentences('Первое. Второе! Третье?')).toEqual(['Первое.', 'Второе!', 'Третье?']);
  });
});
