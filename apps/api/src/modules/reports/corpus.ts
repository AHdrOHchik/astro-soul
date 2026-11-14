import corpus from './corpus.generated.json';

/**
 * Корпус примеров для промптов и судьи (P0-6).
 *
 * Файл `corpus.generated.json` собирается скриптом
 * `scripts/reports/build-corpus.mjs` из `docs/qa/reports/examples.md` и
 * содержит **только** блоки после маркера «Как надо:». Полные главы (§1, §2)
 * и антипримеры (§3.1–3.5) в корпус не попадают: первые задают карту, вторые
 * содержат запрещённую лексику, из-за которой валидаторы забраковали бы
 * любой собранный из них текст.
 *
 * Корпус пересобирается, когда меняется `examples.md`:
 *   node scripts/reports/build-corpus.mjs
 */

export interface CorpusBlock {
  readonly section: string;
  readonly text: string;
}

export interface Corpus {
  readonly version: string;
  readonly source: string;
  readonly blocks: readonly CorpusBlock[];
}

export const EXAMPLES_CORPUS: Corpus = corpus;

/**
 * Few-shot для промпта главы: не больше двух примеров, чтобы не тянуть
 * чужую карту в каждый разбор. Берём по одному на разные аспекты текста.
 */
export function fewShotBlocks(limit = 2): readonly CorpusBlock[] {
  return EXAMPLES_CORPUS.blocks.slice(0, limit);
}

/** Текст для судьи — только примеры «как надо», без антипримеров и рубрики. */
export function judgeExamples(): string {
  return EXAMPLES_CORPUS.blocks.map((block) => block.text).join('\n\n');
}
