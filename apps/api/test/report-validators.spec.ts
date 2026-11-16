import { describe, expect, it } from 'vitest';
import {
  DISCLAIMER,
  maxOverlap,
  openerOf,
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

/**
 * Проверки структуры абзацев (QA-22) проверяются отдельным блоком: здесь
 * фикстуры — одно предложение, растянутое до нужной длины, и падать на
 * «3–6 абзацев» они будут всегда. Остальные правила от этого не зависят.
 */
const STRUCTURAL = new Set(['paragraphs', 'paragraph_sentences', 'word_share', 'sentence_repeat']);

function rules(text: string, precision: 'exact' | 'approximate' | 'unknown' = 'unknown', key: 'core' | 'summary' = 'core') {
  return validateSection({ key, bodyMd: body(text, key), timePrecision: precision });
}

function failed(text: string, precision: 'exact' | 'unknown' = 'unknown', key: 'core' | 'summary' = 'core'): string[] {
  return rules(text, precision, key)
    .failures.map((failure) => failure.rule)
    .filter((rule) => !STRUCTURAL.has(rule));
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
    expect(result.failures.filter((failure) => !STRUCTURAL.has(failure.rule))).toEqual([]);
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
    expect(slightlyLong.failures.filter((failure) => !STRUCTURAL.has(failure.rule))).toEqual([]);
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

/**
 * QA-22: проверки, которые раньше не существовали, — абзацы, длина абзаца,
 * доля частотного слова, дословный повтор предложения внутри главы.
 *
 * Текст fake-llm из приёмки QA-002 (одним абзацем, с четвёркой повторяющихся
 * слов) обязан давать непустой `validation` — иначе эти проверки снова
 * «зелёные» на браке.
 */
describe('QA-22: структура главы', () => {
  const QA_FAKE_TEXT = [
    'Когда дело касается решений, ты долго выбираешь темп для решений и редко об этом жалеешь.',
    'Ты держишь решений в поле зрения, но не позволяешь решений задавать тебе скорость.',
    'Твоя сила в решений проявляется тихо: решений работает, пока другие обсуждают подход.',
    'В разговорах про решений ты сначала проверяешь опору, потом цену решений.',
    'Тебе важно, чтобы решений шло своим ходом, поэтому решений редко бывает быстрым.',
    'Ты не любишь показывать, сколько решений держишь внутри, и прячешь решений за спокойствием.',
    'Ошибку в решений ты замечаешь раньше других и потом долго возвращаешься к решений.',
    'Когда решений требует решения, ты берёшь паузу, и эта пауза в решений тебя не подводит.',
    'Твой способ вести решений выглядит медленным, зато решений почти не даёт сбоев.',
    'Про решений ты говоришь мало, но каждое слово про решений у тебя взвешено.',
    'Тебя успокаивает, когда решений движется ровно, и раздражает, когда решений торопят.',
    'В решений ты опираешься на проверенное, и это делает решений надёжным, но не быстрым.',
].join(' ');

  it('текст fake-llm из приёмки даёт непустой validation', () => {
    const result = validateSection({ key: 'core', bodyMd: QA_FAKE_TEXT, timePrecision: 'exact' });
    const rulesFound = result.failures.map((failure) => failure.rule);

    expect(result.failures.length).toBeGreaterThan(0);
    expect(rulesFound).toContain('paragraphs');
    expect(rulesFound).toContain('word_share');
  });

  it('абзацев меньше трёх или больше шести — провал', () => {
    const two = 'Первое предложение. Второе предложение.\n\nТретье предложение. Четвёртое предложение.';
    expect(
      validateSection({ key: 'core', bodyMd: two, timePrecision: 'exact' }).failures.map((f) => f.rule),
    ).toContain('paragraphs');
  });

  it('в абзаце 1 или 5 предложений — провал по своему коду', () => {
    const one = 'Одно предложение в абзаце.\n\nВторой абзац. Ещё одно. И ещё.\n\nТретий абзац. Тут два.';
    expect(
      validateSection({ key: 'core', bodyMd: one, timePrecision: 'exact' }).failures.map((f) => f.rule),
    ).toContain('paragraph_sentences');
  });

  it('доля самого частого слова выше 12 % — провал; в core порог мягче', () => {
    const repetitive = [
      'Стихия стихия стихия стихия стихия стихия стихия стихия стихия стихия.',
      'Стихия стихия стихия стихия стихия стихия стихия стихия стихия стихия.',
      'Стихия стихия стихия стихия стихия стихия стихия стихия стихия стихия.',
    ].join('\n\n');

    const inPurpose = validateSection({ key: 'purpose', bodyMd: repetitive, timePrecision: 'exact' });
    expect(inPurpose.failures.map((f) => f.rule)).toContain('word_share');

    const inCore = validateSection({ key: 'core', bodyMd: repetitive, timePrecision: 'exact' });
    const share = inCore.failures.find((f) => f.rule === 'word_share');
    // В core порог 18 %, а 100 % «стихии» выше и его.
    expect(share).toBeDefined();
  });

  it('дословно повторённое предложение внутри главы — провал', () => {
    const repeated =
      'Ты возвращаешься к незакрытым разговорам и мысленно доводишь их до конца.\n\n' +
      'Второе предложение здесь другое. И третье тоже другое.\n\n' +
      'Ты возвращаешься к незакрытым разговорам и мысленно доводишь их до конца. Ещё фраза.';

    expect(
      validateSection({ key: 'core', bodyMd: repeated, timePrecision: 'exact' }).failures.map((f) => f.rule),
    ).toContain('sentence_repeat');
  });
});

describe('итерация 19: правила, которые не должны убивать главу', () => {
  /** Правила без структурных шумов — их проверяем отдельно. */
  const clean = (result: ReturnType<typeof validateSection>): string[] =>
    result.failures.map((failure) => failure.rule).filter((rule) => !STRUCTURAL.has(rule));

  it('термины проверяются только в тизере и только у `core`', () => {
    const text = 'Луна в Близнецах даёт быстрый ум. Марс секстилем Юпитеру добавляет азарта.';

    // Глава целиком: термины обязательны, правил о них нет.
    expect(clean(rules(text, 'exact', 'core'))).not.toContain('teaser_terms');

    // Тизер: термин в первых 400 знаках — пометка с фактическим смещением.
    const withTeaser = validateSection({
      key: 'core',
      bodyMd: body(text),
      timePrecision: 'exact',
      teaser: 'Ты быстро связываешь факты, но не считаешь это достижением. Луна в Близнецах…',
    });
    const failure = withTeaser.failures.find((item) => item.rule === 'teaser_terms');
    expect(failure).toBeDefined();
    // Смещение считается по окну тизера, а не по главе: именно этих чисел
    // не хватало в живом прогоне 18.11.2026.
    expect(failure?.detail).toMatch(/«Лун\p{L}*» на \d+-м знаке тизера/u);

    // Не `core` — тизер не проверяется вовсе, даже если передан.
    const emotions = validateSection({
      key: 'emotions',
      bodyMd: body(text),
      timePrecision: 'exact',
      teaser: 'Луна в Близнецах',
    });
    expect(clean(emotions)).not.toContain('teaser_terms');
  });

  it('термины запрещены только в первых 400 знаках, а не во всём `core`', () => {
    const long = `${'Ты замечаешь детали раньше остальных. '.repeat(12)}Луна в Близнецах.`;
    const teaser = long.slice(0, 400);
    const result = validateSection({
      key: 'core',
      bodyMd: body(long.length > 1_200 ? long : `${long} Луна в Близнецах.`),
      timePrecision: 'exact',
      teaser,
    });

    // В окне 400 знаков термина нет — правило молчит, хотя дальше он есть.
    expect(clean(result)).not.toContain('teaser_terms');
  });

  it('служебный словарь: warning по всему тексту, текст не правится', () => {
    const text = 'Цена точки утечки — согласие на отсроченные вознаграждения.';
    expect(clean(rules(text))).toContain('service_terms');

    const details = rules(text).failures.filter((failure) => failure.rule === 'service_terms');
    expect(details.map((failure) => failure.detail)).toContain('точка утечки');
  });

  it('служебный словарь ловит все слова из списка', () => {
    for (const term of [
      'точка утечки',
      'слой скорости',
      'слой прочности',
      'карта покрытия',
      'фокус',
      'промпт',
      'план разбора',
    ]) {
      const result = rules(`Здесь есть ${term} и больше ничего.`);
      expect(clean(result), term).toContain('service_terms');
    }
  });

  it('повтор зачина ловится по первым пяти словам, а не по 8-граммам', () => {
    // Одинаковое начало, разное продолжение: 8-граммы расходятся, а зачин —
    // тот самый, что дал три одинаковые главы на `2 Max`.
    const opener = 'Марс в секстиле с Юпитером даёт оптимизм и готовность пробовать новое.';
    const money = `${opener} Покупки ты обсуждаешь медленно и без азарта, зато решение держишь годами.`;
    const talents = `${opener} Новое ты берёшь короткими заходами и быстро проверяешь на деле.`;
    // Заполнитель нумеруется: одинаковые предложения дают одинаковые
    // 8-граммы и рисуют ложное пересечение в 8-граммах.
    const pad = (text: string, filler: (step: number) => string): string => {
      let result = text;
      let step = 0;
      while (result.length < 1_300) {
        step += 1;
        result += filler(step);
      }
      return result;
    };

    const current = validateSection({
      key: 'money',
      bodyMd: pad(money, (step) => ` Деньги проверяют идею номер ${step} на прочность.`),
      timePrecision: 'exact',
      previous: [pad(talents, (step) => ` Способность проявляется коротким заходом ${step} на деле.`)],
    });

    expect(clean(current)).toContain('repeated_opener');
    // По 8-граммам такое же начало не проваливает главу: пересечение ниже 12 %.
    expect(clean(current)).not.toContain('repeats');
  });

  it('разные зачины не дают пометки', () => {
    const result = validateSection({
      key: 'money',
      bodyMd: body('Деньги ты считаешь способом проверить идею на прочность.'),
      timePrecision: 'exact',
      previous: [body('Марс в секстиле с Юпитером даёт оптимизм и готовность пробовать новое.')],
    });
    expect(clean(result)).not.toContain('repeated_opener');
  });

  it('openerOf нормализует регистр и пунктуацию', () => {
    expect(openerOf('«Марс в секстиле с Юпитером» даёт оптимизм.')).toBe(
      'марс в секстиле с юпитером',
    );
  });

  it('«Итог» короче 500 знаков — отдельное правило без допуска 30 %', () => {
    const short = 'Три действия: скажи вслух цену, откажись от лишнего, назначь финал.'.repeat(6);
    const result = validateSection({
      key: 'summary',
      bodyMd: `${short}\n\n${DISCLAIMER}`,
      timePrecision: 'exact',
    });

    expect(result.failures.map((failure) => failure.rule)).toContain('summary_short');
  });

  it('длинный «Итог» правило не трогает', () => {
    const ok = 'Первое действие — скажи цену вслух. Второе — откажись от лишнего. Третье — назначь финал.'.repeat(8);
    const result = validateSection({
      key: 'summary',
      bodyMd: `${ok}\n\n${DISCLAIMER}`,
      timePrecision: 'exact',
    });
    expect(result.failures.map((failure) => failure.rule)).not.toContain('summary_short');
  });

  it('запрещённые темы больше не error, но по-прежнему считаются', () => {
    // Правило никуда не делось: оно видно в `failures`, но главу не убирает.
    expect(clean(rules('Врач сказал, что это диагноз.'))).toContain('forbidden_health');
  });
});
