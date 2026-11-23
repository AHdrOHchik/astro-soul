import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MOON_ADVICE,
  MOON_ADVICE_FALLBACK,
  MOON_PHASES,
  moonAdvice,
} from '../src/modules/share/share.service';
import { forbiddenTopicIn } from '../src/modules/reports/validators';

/**
 * Строки «чего сегодня лучше не начинать» (контракт 1.6.12, правка к итерации 37).
 *
 * Это **совет** — ровно тот класс текста, который мы запрещаем модели. Он
 * написан нами и уходит наружу под нашим именем, но валидатор разбора его не
 * видел: константы не проходят через `validateSection`. Поэтому проверка идёт
 * тем же списком запрещённых тем (`forbiddenTopicIn` — тот же `FORBIDDEN_TOPICS`,
 * что и у глав разбора), а параметризация по `MOON_ADVICE` гарантирует, что
 * девятая фраза попадёт под проверку сама: забыть её нельзя — она либо в
 * объекте и под тестом, либо объект не компилируется.
 */

const REPO_ROOT = join(process.cwd(), '..', '..');

/** Подписи фаз из сайдкара: дословно, вместе с кавычками. */
async function pythonPhases(): Promise<string[]> {
  const source = await readFile(join(REPO_ROOT, 'packages', 'astro', 'astro', 'daily.py'), 'utf8');
  const block = /^PHASES: Final\[tuple\[tuple\[float, str\], \.\.\.\]\] = \(([\s\S]*?)^\)$/mu.exec(
    source,
  );

  expect(block).not.toBeNull();

  return [...(block?.[1] ?? '').matchAll(/\(\s*\d+(?:\.\d+)?\s*,\s*"([^"]+)"\s*\)/gu)].map(
    (match) => match[1] ?? '',
  );
}

describe('MOON_ADVICE — совет под нашим именем проходит тот же список, что разбор', () => {
  it('сам список запрещённых тем действительно ловит запрещённое', () => {
    // Иначе все проверки ниже проходили бы на пустом месте.
    expect(forbiddenTopicIn('Не начинай лечение без врача: потом будет поздно.')).toBe('health');
    expect(forbiddenTopicIn('Не начинай вкладывать: гарантированный доход обеспечен.')).toBe(
      'money_guarantee',
    );
    expect(forbiddenTopicIn('Не начинай ритуал: это кармический долг.')).toBe('esoterics');
  });

  it('ни одна фраза не попадает в запрещённую тему', () => {
    for (const [phase, phrase] of Object.entries(MOON_ADVICE)) {
      expect({ phase, forbidden: forbiddenTopicIn(phrase) }).toEqual({
        phase,
        forbidden: null,
      });
    }
  });

  it('ни одна фраза не попадает в запрещённую тему — по одной строке на фазу', () => {
    // Параметризация по данным, а не по списку, написанному руками: новая фаза
    // в `MOON_ADVICE` появляется здесь сама.
    for (const phase of MOON_PHASES) {
      const phrase = MOON_ADVICE[phase];
      expect(phrase.length).toBeGreaterThan(20);
      expect(phrase).toMatch(/^Не начинай /u);
      // Никаких чисел: «на 80 %» и «через месяц» — уже предсказание.
      expect(phrase).not.toMatch(/\d/u);
      expect(forbiddenTopicIn(phrase)).toBeNull();
    }
  });

  it('запасная строка тоже проходит проверку', () => {
    expect(forbiddenTopicIn(MOON_ADVICE_FALLBACK)).toBeNull();
    expect(MOON_ADVICE_FALLBACK).toMatch(/^Не начинай /u);
  });

  it('фраз ровно столько, сколько фаз в сайдкаре, и подписи совпадают', async () => {
    const phases = await pythonPhases();
    const unique = [...new Set(phases)];

    expect(unique).toEqual([...MOON_PHASES]);
    expect(Object.keys(MOON_ADVICE).sort()).toEqual([...MOON_PHASES].sort());
  });

  it('незнакомая фаза даёт запасную строку, а не выдумку', () => {
    expect(moonAdvice('новая фаза')).toBe(MOON_ADVICE_FALLBACK);
    expect(moonAdvice('полнолуние')).toBe(MOON_ADVICE.полнолуние);
  });
});
