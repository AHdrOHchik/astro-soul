import type { Chart } from '@astro-soul/shared';

/**
 * `chart_facts` v1.2 — отобранные факторы вместо полной карты (задача C).
 *
 * Замер в playground (GigaChat-2-Max): глава `core` уходила в модель на 2 104
 * токена входа, разбор целиком — ≈27 000 токенов ≈17,5 ₽ при цене 149 ⭐.
 * Вход — главная статья расхода и худший случай, поэтому в промпт идут не все
 * планеты, дома и аспекты, а 7–9 позиций: то, на что промпты глав и так
 * опираются (`SECTION_RULES`).
 *
 * Правила отбора зафиксированы здесь, а не «на вкус модели»:
 *
 *   1. Солнце, Луна, Асцендент и MC — при известном времени; при `unknown`
 *      только Солнце и Луна, без домов (их не существует).
 *   2. Три самых сильных мажорных аспекта по **величине орба** (меньше орб —
 *      точнее аспект), с планетами и знаками.
 *   3. Управитель Асцендента и его дом — если Асцендент известен.
 *   4. Баланс стихий и крестов одной строкой, без перечисления планет.
 *
 * Порядок строк фиксированный (не алфавитный и не «по силе»): одинаковые карты
 * дают одинаковый вход — это нужно и для кэша промпта, и для сравнения
 * стоимости между прогонами.
 *
 * ПДн не проходят: сериализатор читает только `planets`, `asc`, `mc`,
 * `aspects`, `balances` — про `birth.*` он не знает (см. chart-facts.ts).
 */

/** Версия блока. Пишется в промпт и в `reports.chart_facts_version`. */
export const CHART_FACTS_VERSION = 'v1.2';

/** Сколько аспектов берём: «три самых сильных» из задания. */
export const TOP_ASPECTS = 3;

/** Мажорные аспекты: только они участвуют в отборе. */
const MAJOR_ASPECTS = new Set(['conjunction', 'opposition', 'trine', 'square', 'sextile']);

const ASPECT_NAMES: Readonly<Record<string, string>> = {
  conjunction: 'соединение',
  opposition: 'оппозиция',
  trine: 'трин',
  square: 'квадрат',
  sextile: 'секстиль',
};

/**
 * Управители знаков — современные (решение владельца, см.
 * `chart-facts-extras.ts`): Скорпион — Плутон, Водолей — Уран, Рыбы — Нептун.
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

function point(sign: string | undefined, degree: number | undefined, minute: number | undefined): string {
  const degreeText = `${degree ?? 0}°${String(minute ?? 0).padStart(2, '0')}'`;
  return sign === undefined || sign === '' ? degreeText : `${sign} ${degreeText}`;
}

function fraction(value: number | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? String(Math.round(value)) : '0';
}

/** Строка планеты в том же виде, что в v1.1: `sun|Солнце: Телец 26°17' h10`. */
function planetLine(chart: Chart, key: string): string | null {
  const planet = chart.planets.find((candidate) => (candidate.key as string) === key);
  if (planet === undefined) {
    return null;
  }

  const house =
    planet.house === null || planet.house === undefined || chart.asc === null ? '' : ` h${planet.house}`;
  const retrograde = planet.retrograde ? ' R' : '';

  return `${key}|${planet.name}: ${point(planet.sign, planet.degree, planet.minute)}${house}${retrograde}`;
}

/**
 * Три самых сильных мажорных аспекта по величине орба.
 *
 * Сортировка полностью детерминирована: орб → сила → ключи пары. Аспекты с
 * неизвестными планетами отбрасываются: модель не должна увидеть «аспект к
 * Лилит», которой в карте нет.
 */
function topAspects(chart: Chart): string[] {
  const byKey = new Map(chart.planets.map((planet) => [planet.key as string, planet]));

  const candidates = chart.aspects
    .filter((aspect) => MAJOR_ASPECTS.has(aspect.type as string))
    .filter((aspect) => byKey.has(aspect.a) && byKey.has(aspect.b))
    .map((aspect) => ({
      aspect,
      orb: typeof aspect.orb === 'number' && Number.isFinite(aspect.orb) ? aspect.orb : Number.POSITIVE_INFINITY,
      strength: aspect.strength ?? 0,
    }))
    .sort((left, right) => {
      if (left.orb !== right.orb) {
        return left.orb - right.orb;
      }
      if (left.strength !== right.strength) {
        return right.strength - left.strength;
      }
      return `${left.aspect.a}${left.aspect.b}`.localeCompare(`${right.aspect.a}${right.aspect.b}`);
    })
    .slice(0, TOP_ASPECTS);

  return candidates.map(({ aspect, orb, strength }) => {
    const first = byKey.get(aspect.a);
    const second = byKey.get(aspect.b);
    return (
      `${first?.name ?? aspect.a} ${ASPECT_NAMES[aspect.type] ?? aspect.type} ` +
      `${second?.name ?? aspect.b} ` +
      `(${first?.sign ?? '?'}–${second?.sign ?? '?'}, orb${orb.toFixed(1)}, сила ${strength.toFixed(1)})`
    );
  });
}

/**
 * Управитель Асцендента и его дом. `asc` есть только при известном времени.
 *
 * Дом управителя — из карты (планета-управитель), а не из таблицы домов:
 * `PlanetPosition.house` уже посчитан движком.
 */
function ascRulerLine(chart: Chart): string | null {
  const ascSign = chart.asc?.sign;
  if (ascSign === undefined || ascSign === '') {
    return null;
  }

  const rulerKey = RULERS[ascSign];
  if (rulerKey === undefined) {
    return null;
  }

  const ruler = chart.planets.find((planet) => (planet.key as string) === rulerKey);
  if (ruler === undefined) {
    return null;
  }

  const house = ruler.house === null || ruler.house === undefined ? '' : `, h${ruler.house}`;
  return `управитель Асцендента: ${ruler.name} (${rulerKey}) в ${ruler.sign ?? '?'}${house}`;
}

function balancesLine(chart: Chart): string {
  const elements = chart.balances?.elements ?? {};
  const modalities = chart.balances?.modalities ?? {};

  return (
    `стихии fire ${fraction(elements.fire)} earth ${fraction(elements.earth)} ` +
    `air ${fraction(elements.air)} water ${fraction(elements.water)} | ` +
    `кресты cardinal ${fraction(modalities.cardinal)} fixed ${fraction(modalities.fixed)} ` +
    `mutable ${fraction(modalities.mutable)}`
  );
}

/**
 * `chart_facts` v1.2: 7–9 строк, фиксированный порядок.
 *
 * При `time_precision: unknown` строк `asc/mc` и `управитель` нет вовсе — не
 * `null`, а отсутствие: модель не должна пытаться их «вспомнить».
 */
export function serializeTopFactors(chart: Chart): string {
  const precision = chart.birth?.time_precision ?? (chart.birth?.time_known === false ? 'unknown' : 'exact');
  const lines: string[] = [`chart_facts: ${CHART_FACTS_VERSION}`, `time_precision: ${precision}`];

  const sun = planetLine(chart, 'sun');
  if (sun !== null) {
    lines.push(sun);
  }

  const moon = planetLine(chart, 'moon');
  if (moon !== null) {
    lines.push(moon);
  }

  if (precision !== 'unknown' && chart.asc !== null && chart.asc !== undefined) {
    const mc =
      chart.mc === null || chart.mc === undefined
        ? ''
        : ` | mc ${point(chart.mc.sign, chart.mc.degree, chart.mc.minute)}`;
    lines.push(`angles: asc ${point(chart.asc.sign, chart.asc.degree, chart.asc.minute)}${mc}`);
  }

  const aspects = topAspects(chart);
  if (aspects.length > 0) {
    lines.push(`aspects (3 сильнейших по орбу): ${aspects.join(' | ')}`);
  }

  if (precision !== 'unknown') {
    const ruler = ascRulerLine(chart);
    if (ruler !== null) {
      lines.push(ruler);
    }
  }

  lines.push(`balances: ${balancesLine(chart)}`);

  return lines.join('\n');
}
