import { COMPAT_SECTIONS, type CompatSectionKey } from './compat-validators';
import type { CompatFactor } from './compat-facts';

/**
 * Карта «факт × раздел» для совместимости — детерминированное распределение,
 * как `focus-map.ts` разбора, но со своим лимитом и своей таблицей.
 *
 * Зачем лимит: на трёх живых прогонах разбора один фактор становился мотором
 * 5–6 глав из 7, и текст читался как один тезис семь раз. У совместимости
 * разделов четыре, и повтор одного факта в трёх из них — та же калька, только
 * короче. Поэтому лимит вводится сразу, до первого живого прогона:
 * `MAX_SECTIONS_PER_FACTOR = 2`, и тест падает, если факт звучит в трёх.
 */

/** Жёсткий лимит: один факт — максимум в двух разделах. */
export const MAX_SECTIONS_PER_FACTOR = 2;

/** Сколько фактов получает раздел. Больше трёх — снова «упомяни всё». */
export const SECTION_FACTOR_MIN = 2;
export const SECTION_FACTOR_MAX = 3;

export type FactorRole = 'main' | 'angle';

/**
 * Таблица покрытия: категория факта → разделы, где он уместен.
 * `main` — раздел держится на этом факте, `angle` — упоминается под своим углом.
 *
 * Правило редакционное, а не математическое: узнавание («мы правда такие») —
 * это светила и совпадения; трение — напряжение (квадраты, оппозиции,
 * Сатурн); механика разговора — Меркурий, Марс и внешние планеты; шаги —
 * то, что можно сделать, опираясь на сильную сторону пары.
 */
export const COMPAT_COVERAGE: Readonly<Record<string, Readonly<Partial<Record<CompatSectionKey, FactorRole>>>>> = {
  aspect_luminary: { clicks: 'main', friction: 'angle', scenario: 'angle', steps: 'angle' },
  aspect_venus_mars: { clicks: 'main', friction: 'main', scenario: 'main', steps: 'angle' },
  aspect_personal: { clicks: 'angle', friction: 'main', scenario: 'main', steps: 'main' },
  aspect_social: { clicks: 'angle', friction: 'main', scenario: 'main', steps: 'main' },
  aspect_outer: { clicks: 'angle', friction: 'angle', scenario: 'main', steps: 'angle' },
  balance_element: { clicks: 'main', friction: 'angle', steps: 'angle' },
  balance_cross: { clicks: 'angle', friction: 'angle', scenario: 'main' },
  overlay: { clicks: 'angle', friction: 'angle', scenario: 'angle', steps: 'angle' },
};

export interface AssignedFactor extends CompatFactor {
  /** Номер факта в исходном списке: по нему видно, какой факт куда ушёл. */
  readonly index: number;
}

export interface CompatDistribution {
  readonly bySection: Readonly<Record<CompatSectionKey, readonly AssignedFactor[]>>;
  readonly counts: Readonly<Record<CompatSectionKey, number>>;
  /** Категории, которых нет в таблице покрытия (их видно в логе). */
  readonly unmapped: readonly string[];
  /** Разделы, которым не хватило фактов под лимит (0–1 факт). */
  readonly starved: readonly CompatSectionKey[];
}

function roleOf(category: string, section: CompatSectionKey): FactorRole | undefined {
  return COMPAT_COVERAGE[category]?.[section];
}

function scoreOf(factor: AssignedFactor, section: CompatSectionKey): number {
  const role = roleOf(factor.category, section);
  if (role === 'main') {
    return 2;
  }
  return role === 'angle' ? 1 : 0;
}

/**
 * Раскладка фактов по разделам.
 *
 * Правила, все детерминированные:
 *   1. Один факт — максимум `MAX_SECTIONS_PER_FACTOR` разделов.
 *   2. Кандидаты сортируются по силе связи с разделом (`main` сильнее
 *      `angle`), затем по значимости факта, затем по номеру в списке.
 *   3. В разделе 2–3 факта; при конфликте берётся следующий по значимости
 *      факт, а не повторяется сильнейший. Не хватило — раздел с одним фактом,
 *      но **никогда** копия исчерпанного.
 *   4. Одна категория внутри раздела не повторяется: два разных аспекта
 *      одной и той же пары — это один факт, пересказанный дважды.
 */
export function distributeSections(
  factors: readonly CompatFactor[],
  options: { readonly maxPerFactor?: number } = {},
): CompatDistribution {
  const limit = options.maxPerFactor ?? MAX_SECTIONS_PER_FACTOR;
  const prepared: AssignedFactor[] = factors.map((factor, index) => ({ ...factor, index }));

  const usedBy = new Map<string, Set<CompatSectionKey>>();
  const usedIn = (id: string): Set<CompatSectionKey> => {
    const existing = usedBy.get(id);
    if (existing !== undefined) {
      return existing;
    }
    const created = new Set<CompatSectionKey>();
    usedBy.set(id, created);
    return created;
  };

  const bySection = {} as Record<CompatSectionKey, AssignedFactor[]>;
  const counts = {} as Record<CompatSectionKey, number>;

  const canTake = (
    factor: AssignedFactor,
    section: CompatSectionKey,
    chosen: readonly AssignedFactor[],
  ): boolean =>
    !chosen.some((item) => item.category === factor.category) &&
    (usedIn(factor.id).has(section) || usedIn(factor.id).size < limit);

  for (const section of COMPAT_SECTIONS) {
    const candidates = prepared
      .map((factor) => ({ factor, score: scoreOf(factor, section) }))
      .filter((item) => item.score > 0)
      .sort(
        (a, b) =>
          b.score - a.score ||
          a.factor.significance - b.factor.significance ||
          a.factor.index - b.factor.index,
      )
      .map((item) => item.factor);

    const chosen: AssignedFactor[] = [];

    for (const factor of candidates) {
      if (chosen.length >= SECTION_FACTOR_MAX) {
        break;
      }
      if (!canTake(factor, section, chosen)) {
        continue;
      }
      chosen.push(factor);
    }

    // Добираем до минимума только теми фактами, что ещё не исчерпали лимит.
    if (chosen.length < SECTION_FACTOR_MIN) {
      for (const factor of prepared) {
        if (chosen.length >= SECTION_FACTOR_MIN) {
          break;
        }
        if (chosen.includes(factor)) {
          continue;
        }
        if (!canTake(factor, section, chosen)) {
          continue;
        }
        chosen.push(factor);
      }
    }

    for (const factor of chosen) {
      usedIn(factor.id).add(section);
    }

    chosen.sort((a, b) => a.index - b.index);
    bySection[section] = chosen;
    counts[section] = chosen.length;
  }

  const unmapped = [
    ...new Set(
      prepared
        .filter((factor) => COMPAT_COVERAGE[factor.category] === undefined)
        .map((factor) => factor.category),
    ),
  ];

  const starved = COMPAT_SECTIONS.filter((section) => counts[section] < SECTION_FACTOR_MIN);

  return { bySection, counts, unmapped, starved };
}

/** Строка матрицы: факт и разделы, где он звучит. */
export interface CompatMatrixRow {
  readonly factor: string;
  readonly label: string;
  readonly sections: readonly CompatSectionKey[];
  readonly count: number;
}

/**
 * Матрица «факт × раздел» для отчёта и теста-предохранителя.
 * `count > MAX_SECTIONS_PER_FACTOR` — нарушение инварианта.
 */
export function compatMatrix(distribution: CompatDistribution): readonly CompatMatrixRow[] {
  const rows = new Map<string, { label: string; sections: Set<CompatSectionKey> }>();

  for (const section of COMPAT_SECTIONS) {
    for (const factor of distribution.bySection[section]) {
      const entry = rows.get(factor.id) ?? { label: factor.label, sections: new Set<CompatSectionKey>() };
      entry.sections.add(section);
      rows.set(factor.id, entry);
    }
  }

  return [...rows.entries()]
    .map(([factor, entry]) => ({
      factor,
      label: entry.label,
      sections: COMPAT_SECTIONS.filter((section) => entry.sections.has(section)),
      count: entry.sections.size,
    }))
    .sort((a, b) => b.count - a.count || a.factor.localeCompare(b.factor));
}

/** `{{focus_block}}` раздела: 2–3 строки готовых фактов. */
export function focusBlockFor(distribution: CompatDistribution, section: CompatSectionKey): string {
  const lines = distribution.bySection[section].map(
    (factor, position) => `${position + 1}. ${factor.label}`,
  );

  if (lines.length === 0) {
    return 'Своих фактов у этого раздела нет: опирайся на общий список фактов, но не пересказывай другие разделы.';
  }

  return lines.join('\n');
}
