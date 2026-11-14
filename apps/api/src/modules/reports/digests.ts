import { splitSentences } from './validators';

/**
 * Сводки глав — кодом, без отдельного вызова LLM (P0-4).
 *
 * Сводка нужна в двух местах: `{{previous_summary}}` в промпте следующей
 * главы и `{{chapter_digests}}` в промпте «Итога». Отдельный вызов на каждую
 * главу — это ещё 7 вызовов на разбор; при 60–90 знаках модель не напишет
 * ничего лучше, чем два предложения из готового текста.
 *
 * Правило из задания: первое предложение + самое длинное предложение
 * середины, усечённое до 90 знаков по границе слова.
 */
export const DIGEST_MAX = 90;

function shortestTrim(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }

  const cut = text.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  const trimmed = (lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd();

  // Точку в конце усечённой фразы ставим сами: обрезка не должна оставлять
  // «висящее» предложение без знака конца.
  return /[.!?…]$/u.test(trimmed) ? trimmed : `${trimmed}…`;
}

export function buildDigest(bodyMd: string): string {
  const sentences = splitSentences(bodyMd.trim());
  if (sentences.length === 0) {
    return '';
  }

  const first = sentences[0] ?? '';
  if (sentences.length === 1) {
    return shortestTrim(first, DIGEST_MAX);
  }

  // «Середина» — всё, кроме первого и последнего предложения: последнее в
  // «Итоге» почти всегда дисклеймер или вывод, а он в сводке не нужен.
  const middle = sentences.slice(1, Math.max(2, sentences.length - 1));
  const longest = middle.reduce((best, sentence) =>
    sentence.length > best.length ? sentence : best,
  );

  const combined = `${first} ${longest}`;
  return shortestTrim(combined, DIGEST_MAX);
}
