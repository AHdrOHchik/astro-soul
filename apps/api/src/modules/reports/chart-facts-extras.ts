import type { Chart } from '@astro-soul/shared';

/**
 * Дополнительные факты, которых нет в контракте `Chart`, но которые нужны
 * структуре разбора (P0-2 и P0-3).
 *
 * Контракт 1.5.1 не содержит ни `chart.angle_aspects`, ни `chart.rulers`,
 * поэтому поля не добавляются в `Chart` и не отдаются клиенту: они считаются
 * здесь и дописываются к `chart_facts` отдельными строками. Когда (и если)
 * владелец решит вынести их в контракт — это будет версия 1.6.0.
 */

/** Знаки в порядке зодиака: индекс = номер знака от Овна. */
const SIGNS = [
  'Овен',
  'Телец',
  'Близнецы',
  'Рак',
  'Лев',
  'Дева',
  'Весы',
  'Скорпион',
  'Стрелец',
  'Козерог',
  'Водолей',
  'Рыбы',
] as const;

/**
 * Управители знаков. Решение владельца — **современные**: Скорпион — Плутон,
 * Водолей — Уран, Рыбы — Нептун (СПОРНО: классическая школа отдала бы Марс,
 * Сатурн и Юпитер — см. отчёт).
 */
const RULERS: Readonly<Record<string, string>> = {
  Овен: 'mars',
  Телец: 'venus',
  Близнецы: 'mercury',
  Рак: 'moon',
  Лев: 'sun',
  Дева: 'mercury',
  Весы: 'venus',
  Скорпион: 'pluto',
  Стрелец: 'jupiter',
  Козерог: 'saturn',
  Водолей: 'uranus',
  Рыбы: 'neptune',
};

const ANGLE_NAMES: Readonly<Record<string, string>> = {
  conjunction: 'соединение',
  opposition: 'оппозиция',
  trine: 'трин',
  square: 'квадрат',
  sextile: 'секстиль',
};

/** Орбисы для аспектов к углам: углы чувствительнее планет, orb уже. */
const ANGLE_ASPECTS: readonly { readonly type: string; readonly angle: number; readonly orb: number }[] = [
  { type: 'conjunction', angle: 0, orb: 6 },
  { type: 'opposition', angle: 180, orb: 6 },
  { type: 'trine', angle: 120, orb: 5 },
  { type: 'square', angle: 90, orb: 5 },
  { type: 'sextile', angle: 60, orb: 4 },
];

function longitude(sign: string | undefined, degree: number | undefined, minute: number | undefined): number | null {
  const index = SIGNS.indexOf((sign ?? '') as (typeof SIGNS)[number]);
  if (index < 0) {
    return null;
  }
  return index * 30 + (degree ?? 0) + (minute ?? 0) / 60;
}

function angularDistance(left: number, right: number): number {
  const diff = Math.abs(left - right) % 360;
  return diff > 180 ? 360 - diff : diff;
}

export interface AngleAspect {
  readonly planet: string;
  readonly target: 'asc' | 'mc';
  readonly type: string;
  readonly orb: number;
  readonly strength: number;
}

/**
 * Аспекты планет к Асценденту и MC (P0-2).
 *
 * В `chart.aspects` только пары планет; «планета на Асценденте» — лучший
 * материал для тизера, и без этого шага `core` и `relations` его теряют.
 * При неизвестном времени углов нет — пустой массив.
 */
export function angleAspects(chart: Chart): AngleAspect[] {
  const asc =
    chart.asc === null || chart.asc === undefined
      ? null
      : longitude(chart.asc.sign, chart.asc.degree, chart.asc.minute);
  const mc =
    chart.mc === null || chart.mc === undefined
      ? null
      : longitude(chart.mc.sign, chart.mc.degree, chart.mc.minute);

  if (asc === null && mc === null) {
    return [];
  }

  const result: AngleAspect[] = [];

  for (const planet of chart.planets) {
    const position = longitude(planet.sign, planet.degree, planet.minute);
    if (position === null) {
      continue;
    }

    for (const [target, angle] of [
      ['asc', asc],
      ['mc', mc],
    ] as const) {
      if (angle === null) {
        continue;
      }
      for (const aspect of ANGLE_ASPECTS) {
        const orb = Math.abs(angularDistance(position, angle) - aspect.angle);
        if (orb <= aspect.orb) {
          // Сила — доля от максимального орба: 1.0 на точном аспекте.
          const strength = Math.round((1 - orb / aspect.orb) * 10) / 10;
          result.push({ planet: planet.key, target, type: aspect.type, orb: Math.round(orb * 10) / 10, strength });
        }
      }
    }
  }

  return result.sort((left, right) => right.strength - left.strength);
}

export function serializeAngleAspects(chart: Chart): string {
  const aspects = angleAspects(chart);
  if (aspects.length === 0) {
    return '';
  }

  const nameOf = new Map<string, string>(
    chart.planets.map((planet) => [planet.key as string, planet.name ?? '']),
  );
  const list = aspects
    .map(
      (aspect) =>
        `${nameOf.get(aspect.planet) ?? aspect.planet} ${ANGLE_NAMES[aspect.type] ?? aspect.type} ` +
        `${aspect.target.toUpperCase()} ${aspect.strength.toFixed(1)} orb${aspect.orb.toFixed(1)}`,
    )
    .join(' | ');

  return `angle_aspects: ${list}`;
}

export interface RulerFacts {
  readonly sign: string;
  readonly ruler: string;
  readonly rulerSign: string | null;
  readonly rulerHouse: number | null;
}

/** Управитель знака куспида и где стоит он сам (P0-3). */
export function rulerOf(
  cusp: { sign?: string | undefined; degree?: number | undefined },
  chart: Chart,
): RulerFacts | null {
  const ruler = RULERS[cusp.sign ?? ''];
  if (ruler === undefined) {
    return null;
  }

  const planet = chart.planets.find((candidate) => candidate.key === ruler);
  return {
    sign: cusp.sign ?? '',
    ruler,
    rulerSign: planet?.sign ?? null,
    rulerHouse: planet?.house ?? null,
  };
}

/**
 * Управители Асцендента и домов 6, 7, 10 — точки опоры для `money` и
 * `relations`. При неизвестном времени возвращается `null`: куспидов нет.
 */
export function houseRulers(chart: Chart): {
  asc: RulerFacts | null;
  house6: RulerFacts | null;
  house7: RulerFacts | null;
  house10: RulerFacts | null;
} | null {
  if (chart.asc === null || chart.asc === undefined || chart.houses === null || chart.houses === undefined) {
    return null;
  }

  const byNumber = new Map<number, Chart['houses'] extends (infer T)[] | null ? T : never>(
    chart.houses.map((house) => [house.house ?? 0, house]),
  );
  const rulerFor = (number: number): RulerFacts | null => {
    const cusp = byNumber.get(number);
    return cusp === undefined ? null : rulerOf(cusp, chart);
  };

  return {
    asc: rulerOf(chart.asc, chart),
    house6: rulerFor(6),
    house7: rulerFor(7),
    house10: rulerFor(10),
  };
}

export function serializeRulers(chart: Chart): string {
  const rulers = houseRulers(chart);
  if (rulers === null) {
    return '';
  }

  const format = (label: string, facts: RulerFacts | null): string | null => {
    if (facts === null) {
      return null;
    }
    const sign = facts.rulerSign ?? '—';
    const house = facts.rulerHouse === null ? '—' : `h${facts.rulerHouse}`;
    return `${label} ${facts.sign} → ${facts.ruler} в ${sign} ${house}`;
  };

  const parts = [
    format('asc', rulers.asc),
    format('h6', rulers.house6),
    format('h7', rulers.house7),
    format('h10', rulers.house10),
  ].filter((part): part is string => part !== null);

  return parts.length === 0 ? '' : `rulers: ${parts.join(' | ')}`;
}

/** Всё, что дописывается к `chart_facts` после документированного формата. */
export function serializeChartFactsExtras(chart: Chart): string {
  return [serializeAngleAspects(chart), serializeRulers(chart)].filter((line) => line !== '').join('\n');
}
