import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CHAPTER_FOCUS_MAX,
  CHAPTER_FOCUS_MIN,
  CONTENT_SECTIONS,
  COVERAGE,
  MAX_CHAPTERS_PER_FACTOR,
  distributeFocuses,
  factorMatrix,
  factorRows,
  focusBlockFor,
  type PlanFocus,
} from '../src/modules/reports/focus-map';

/**
 * Предохранитель главного пункта итерации 19: **один фактор звучит максимум
 * в трёх главах** (`structure.md` §3.1).
 *
 * Что было: живые прогоны 18.11.2026 дали «мотор» разбора в 6 из 7 глав
 * (`3 Ultra`, квадрат Меркурия к Юпитеру) и в 5 из 6 (`2 Max`, Марс секстиль
 * Юпитер). Человек читал один тезис, пересказанный семь раз. Дефект
 * воспроизвёлся на двух моделях, значит причина в детерминированной карте,
 * а не в модели.
 *
 * Тест держит два условия:
 *   1. матрица «фактор × глава» на **реальной карте** (фикстура
 *      `measure-chart.json`, та же карта, что в `structure.md` §3.2) не имеет
 *      ни одной строки больше трёх;
 *   2. проверка не пустая: в этой карте есть фактор, который по карте
 *      покрытия претендует на 6 глав, — если лимит убрать, тест падает.
 */

interface ChartFixture {
  readonly planets: readonly {
    readonly key: string;
    readonly name: string;
    readonly sign: string;
    readonly house: number | null;
  }[];
  readonly aspects: readonly {
    readonly a: string;
    readonly b: string;
    readonly type: string;
    readonly strength: number;
  }[];
  readonly balances: { readonly elements: Record<string, number> };
}

const CHART: ChartFixture = JSON.parse(
  readFileSync(join(__dirname, 'fixtures/measure-chart.json'), 'utf8'),
) as ChartFixture;

const ASPECT_NAMES: Record<string, string> = {
  trine: 'трин',
  square: 'квадрат',
  opposition: 'оппозиция',
  sextile: 'секстиль',
  conjunction: 'соединение',
  quincunx: 'квиконс',
};

const ELEMENT_NAMES: Record<string, string> = {
  fire: 'огонь',
  earth: 'земля',
  air: 'воздух',
  water: 'вода',
};

/**
 * План, который строит модель по этой карте: сильные аспекты и положения
 * планет. Ничего не выдумываем — берём факты из фикстуры.
 */
function planFromChart(): PlanFocus[] {
  const focuses: PlanFocus[] = [];

  for (const planet of CHART.planets) {
    focuses.push({
      topic: `${planet.name}: кто я`,
      factor: `${planet.name} в ${planet.sign}${planet.house === null ? '' : `, ${planet.house}-й дом`}`,
      angle: 'как это видно в жизни',
    });
  }

  for (const aspect of CHART.aspects) {
    if (aspect.strength < 0.6) {
      continue;
    }
    const left = CHART.planets.find((planet) => planet.key === aspect.a)?.name ?? aspect.a;
    const right = CHART.planets.find((planet) => planet.key === aspect.b)?.name ?? aspect.b;
    focuses.push({
      topic: `${left} и ${right}`,
      factor: `${left} ${ASPECT_NAMES[aspect.type] ?? aspect.type} ${right}`,
      angle: 'что из этого следует',
    });
  }

  const element = Object.entries(CHART.balances.elements).sort((a, b) => b[1] - a[1])[0];
  if (element !== undefined) {
    focuses.push({
      topic: 'темп',
      factor: `${ELEMENT_NAMES[element[0]] ?? element[0]} ${element[1]} %`,
      angle: 'как быстро ты начинаешь',
    });
  }

  return focuses;
}

describe('карта факторов: лимит «фактор ≤ 3 главы»', () => {
  it('на реальной карте максимум по строке матрицы ≤ 3', () => {
    const distribution = distributeFocuses(planFromChart());
    const matrix = factorMatrix(distribution);

    expect(matrix.length).toBeGreaterThan(3);
    for (const row of matrix) {
      expect(row.count, `фактор ${row.factor} звучит в ${row.count} главах`).toBeLessThanOrEqual(
        MAX_CHAPTERS_PER_FACTOR,
      );
    }
  });

  it('проверка не пустая: без лимита аспект внешних планет ушёл бы в 6 глав', () => {
    // «Аспекты внешних планет» по карте покрытия — угол во всех шести главах.
    // Старое поведение («все главы, где score > 0») давало именно 6.
    const potential = Object.values(COVERAGE['aspects_outer'] ?? {}).filter(
      (role) => role !== undefined,
    ).length;
    expect(potential).toBe(6);
    expect(potential).toBeGreaterThan(MAX_CHAPTERS_PER_FACTOR);

    const matrix = factorMatrix(distributeFocuses(planFromChart()));
    const outer = matrix.find((row) => row.factor === 'aspects_outer');
    expect(outer).toBeDefined();
    expect(outer?.count).toBeLessThanOrEqual(MAX_CHAPTERS_PER_FACTOR);
  });

  it('«мотор» плана, повторённый моделью трижды, не размножается', () => {
    // Ровно дефект живого прогона: сильнейший аспект попал в три фокуса.
    const motor: PlanFocus = {
      topic: 'оптимизм',
      factor: 'Марс секстиль Юпитер',
      angle: 'готовность пробовать новое',
    };
    const distribution = distributeFocuses([
      motor,
      { ...motor, topic: 'рост' },
      { ...motor, topic: 'энергия' },
      { topic: 'ум', factor: 'Меркурий в Близнецах', angle: 'связи на ходу' },
      { topic: 'реализация', factor: 'Солнце в Тельце, 10-й дом', angle: 'репутация' },
    ]);

    const matrix = factorMatrix(distribution);
    for (const row of matrix) {
      expect(row.count).toBeLessThanOrEqual(MAX_CHAPTERS_PER_FACTOR);
    }

    // И внутри главы один фактор не повторяется дважды.
    for (const chapter of CONTENT_SECTIONS) {
      const rows = distribution.byChapter[chapter].flatMap((focus) => focus.rows);
      expect(new Set(rows).size, `глава ${chapter} повторяет фактор`).toBe(rows.length);
    }
  });

  it('узкий план: глава получает меньше двух фокусов, а не копию', () => {
    const motor: PlanFocus = { topic: 'рост', factor: 'Марс секстиль Юпитер', angle: 'a' };
    const distribution = distributeFocuses([motor, { ...motor, topic: 'b' }, { ...motor, topic: 'c' }]);

    expect(distribution.starved.length).toBeGreaterThan(0);
    for (const chapter of CONTENT_SECTIONS) {
      expect(distribution.counts[chapter]).toBeLessThanOrEqual(CHAPTER_FOCUS_MAX);
      for (const focus of distribution.byChapter[chapter]) {
        expect(focus.rows).toContain('aspects_mars');
      }
    }
    // Ни одной главы, где один и тот же фактор взят трижды.
    for (const chapter of CONTENT_SECTIONS) {
      expect(distribution.counts[chapter]).toBeLessThanOrEqual(1);
    }
  });

  it('распределение детерминированное, а у каждой главы 2–3 фокуса, где хватило факторов', () => {
    const plan = planFromChart();
    const first = distributeFocuses(plan);
    const second = distributeFocuses(plan);

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));

    for (const chapter of CONTENT_SECTIONS) {
      const count = first.counts[chapter];
      if (first.starved.includes(chapter)) {
        expect(count).toBeLessThan(CHAPTER_FOCUS_MIN);
      } else {
        expect(count).toBeGreaterThanOrEqual(CHAPTER_FOCUS_MIN);
        expect(count).toBeLessThanOrEqual(CHAPTER_FOCUS_MAX);
      }
    }
  });

  it('глава без своих фокусов получает честную подсказку, а не пустоту', () => {
    const motor: PlanFocus = { topic: 'рост', factor: 'Марс секстиль Юпитер', angle: 'a' };
    const distribution = distributeFocuses([
      motor,
      { ...motor, topic: 'b' },
      { ...motor, topic: 'c' },
    ]);
    const empty = CONTENT_SECTIONS.find((chapter) => distribution.counts[chapter] === 0);
    expect(empty).toBeDefined();
    expect(focusBlockFor(distribution, empty ?? 'purpose')).toContain(
      'Своих фокусов у этой главы нет',
    );
  });

  it('факторы читаются из человеческой формулировки фокуса', () => {
    expect(factorRows('Марс секстиль Юпитер')).toEqual(
      expect.arrayContaining(['aspects_outer']),
    );
    expect(factorRows('Луна в Льве, 1-й дом')).toEqual(
      expect.arrayContaining(['moon_house', 'house_1']),
    );
  });
});
