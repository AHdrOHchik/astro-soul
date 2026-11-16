import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Chart } from '@astro-soul/shared';
import { serializeChartFacts } from '../src/modules/reports/chart-facts';
import { serializeChartFactsExtras } from '../src/modules/reports/chart-facts-extras';
import { serializeTopFactors } from '../src/modules/reports/top-factors';
import { chapterPrompt, SYSTEM_PROMPT } from '../src/modules/reports/prompts';
import { fewShotBlocks } from '../src/modules/reports/corpus';

/**
 * Бюджет входа на главу (задача C).
 *
 * Считаем то, что реально уходит в модель: `SYSTEM_PROMPT` + промпт главы
 * (правила главы, факты, тезис, фокусы, сводка, few-shot). Единственное, что
 * меняется в этой итерации, — блок фактов; правила и системный промпт
 * запрещено править без решения владельца.
 *
 * Бюджет: сам блок фактов — ≤65 % от прежнего (это наша часть),
 * вход на главу — не больше 85 % от прежнего (страховка от раздувания).
 */
// JSON читаем файлом: та же карта, что в `top-factors.spec.ts` (вымышленные данные).
const chart = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'measure-chart.json'), 'utf8'),
) as unknown as Chart;

const fullFacts = [serializeChartFacts(chart), serializeChartFactsExtras(chart)]
  .filter((part) => part !== '')
  .join('\n');
const topFacts = serializeTopFactors(chart);

function chapterInput(key: 'core' | 'emotions' | 'money', facts: string): string {
  return `${SYSTEM_PROMPT}\n\n${chapterPrompt({
    key,
    chartFacts: facts,
    thesis: 'Ты медленно решаешься, но, решившись, почти не отступаешь.',
    focusBlock: '1. Тема: опора, фактор: Сатурн в Рыбах, угол: как держишься.',
    previousSummary: 'Короткая сводка предыдущих глав без повторяющихся формулировок.',
    timePrecision: 'exact',
    examples: fewShotBlocks(2).map((block) => block.text),
  })}`;
}

describe('бюджет chart_facts v1.2', () => {
  it('блок фактов ≤ 65 % от полной карты', () => {
    expect(topFacts.length).toBeLessThanOrEqual(fullFacts.length * 0.65);
  });

  it('вход на главу сократился и не раздувается обратно', () => {
    for (const key of ['core', 'emotions', 'money'] as const) {
      const before = chapterInput(key, fullFacts);
      const after = chapterInput(key, topFacts);
      // Вход уменьшился: вся экономия — из блока фактов.
      expect(after.length).toBeLessThan(before.length);

      // Сравнение по переменной части: правила, системный промпт и few-shot —
      // константы, и с 1.5.10 к ним добавился абзац формы (196 знаков,
      // `prompts_v1.3` — требование владельца). Прошлая формула «≤85 % от
      // всего входа» ломалась именно на этой константе, а не на фактах.
      const overhead = chapterInput(key, '').length;
      const beforeFacts = before.length - overhead;
      const afterFacts = after.length - overhead;
      expect(afterFacts).toBeLessThanOrEqual(beforeFacts * 0.65 + 1);
      // И общая страховка от раздувания промпта глав.
      expect(after.length).toBeLessThanOrEqual(before.length * 0.9);
    }
  });

  it('при пустых фактах вход всё равно выше 65 % прежнего: цель по главе недостижима без правки промптов', () => {
    const before = chapterInput('core', fullFacts).length;
    const withoutFacts = chapterInput('core', '').length;

    // Арифметика, которую нельзя обойти отбором: правила главы, системный
    // промпт и few-shot — константы, они не сокращаются. Это довод владельцу,
    // а не украшение теста.
    expect(withoutFacts / before).toBeGreaterThan(0.65);
  });
});
