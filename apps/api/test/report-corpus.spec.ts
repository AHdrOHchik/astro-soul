import { describe, expect, it } from 'vitest';
import { EXAMPLES_CORPUS, fewShotBlocks, judgeExamples } from '../src/modules/reports/corpus';

/** Подстроки из задания к P0-6: их в корпусе быть не может. */
const FORBIDDEN = ['карм', 'мисси', 'в прошлой жизни', 'Вселенная ведёт', 'предсказан'];

describe('P0-6: корпус примеров', () => {
  it('собран из файла, а не написан руками', () => {
    expect(EXAMPLES_CORPUS.source).toBe('docs/qa/reports/examples.md');
    expect(EXAMPLES_CORPUS.blocks.length).toBeGreaterThan(0);
    expect(EXAMPLES_CORPUS.blocks.every((block) => block.text.trim() !== '')).toBe(true);
  });

  it('не содержит запрещённых подстрок', () => {
    const text = judgeExamples().toLowerCase();
    for (const forbidden of FORBIDDEN) {
      expect(text).not.toContain(forbidden.toLowerCase());
    }
  });

  it('состоит только из блоков §3 (антипримеры), а не из полных глав §1–§2', () => {
    expect(EXAMPLES_CORPUS.blocks.every((block) => block.section.startsWith('3.'))).toBe(true);

    // Начала полных глав из §1 и §2 в корпус попасть не должны: как few-shot
    // они задают конкретную карту.
    const text = judgeExamples();
    expect(text).not.toContain('Ты редко торопишься');
    expect(text).not.toContain('У тебя нет иллюзий про деньги');
  });

  it('few-shot ограничен двумя блоками', () => {
    expect(fewShotBlocks()).toHaveLength(2);
    expect(fewShotBlocks(1)).toHaveLength(1);
  });
});
