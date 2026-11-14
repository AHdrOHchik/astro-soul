import type { Chart } from '@astro-soul/shared';

/**
 * Сериализатор `chart_facts` (P0-1, `docs/qa/reports/backend-requests.md` §P0-1).
 *
 * Единственный источник данных для LLM. Здесь важны три свойства:
 *
 *   1. **Белый список.** В текст попадают только планеты, углы, дома, аспекты,
 *      балансы, точность времени и выключенные планеты. `chart.birth.*` —
 *      дата, время, место, координаты — не проходят не потому, что «мы их не
 *      передаём», а потому, что сериализатор про них не знает: он собирает
 *      строки из перечисленных полей и ничего больше. Это же свойство
 *      проверяется тестом «в выводе нет даты и места рождения».
 *
 *   2. **Детерминированный порядок.** Планеты — по фиксированному списку,
 *      аспекты — по убыванию силы, дома — по номеру. Стабильный префикс
 *      промпта открывает кэширование входа у провайдера.
 *
 *   3. **Два регистра в одном тексте.** `sun|Солнце: Телец 26°17' h10` —
 *      машинный ключ нужен коду (`AskResponse.based_on`), русское имя —
 *      модели, чтобы она не придумывала названия знаков и планет.
 */

/** Порядок планет фиксирован: он часть контракта промпта, а не вкус. */
const PLANET_ORDER = [
  'sun',
  'moon',
  'mercury',
  'venus',
  'mars',
  'jupiter',
  'saturn',
  'uranus',
  'neptune',
  'pluto',
  'node',
  'chiron',
] as const;

const ASPECT_NAMES: Readonly<Record<string, string>> = {
  conjunction: 'соединение',
  opposition: 'оппозиция',
  trine: 'трин',
  square: 'квадрат',
  sextile: 'секстиль',
};

/**
 * `26°17'` — градусы без ведущего нуля (как в задании: `4°02'`), минуты двумя
 * цифрами. Пробелов нет: строка остаётся одной лексемой для модели.
 */
function degrees(degree: number, minute: number): string {
  return `${degree}°${String(minute).padStart(2, '0')}'`;
}

/** Предложный падеж знаков — для подписей вида «Солнце в Тельце». */
const SIGN_PREPOSITIONAL: Readonly<Record<string, string>> = {
  Овен: 'Овне',
  Телец: 'Тельце',
  Близнецы: 'Близнецах',
  Рак: 'Раке',
  Лев: 'Льве',
  Дева: 'Деве',
  Весы: 'Весах',
  Скорпион: 'Скорпионе',
  Стрелец: 'Стрельце',
  Козерог: 'Козероге',
  Водолей: 'Водолее',
  Рыбы: 'Рыбах',
};

function position(sign: string, degree: number, minute: number): string {
  return `${sign} ${degrees(degree, minute)}`;
}

function strength(value: number | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(1) : '0.0';
}

function orb(value: number | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(1) : '0.0';
}

function share(value: number | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? String(Math.round(value)) : '0';
}

/** Планеты в фиксированном порядке: незнакомые ключи в текст не попадают. */
function planetsBlock(chart: Chart): string[] {
  const byKey = new Map(chart.planets.map((planet) => [planet.key, planet] as const));
  const lines: string[] = [];

  for (const key of PLANET_ORDER) {
    const planet = byKey.get(key);
    if (planet === undefined) {
      continue;
    }

    const retrograde = planet.retrograde ? ' R' : '';
    // При неизвестном времени дома нет — поле `h` опускается целиком.
    const house = planet.house === null || planet.house === undefined ? '' : ` h${planet.house}`;
    lines.push(`${key}|${planet.name}: ${position(planet.sign, planet.degree, planet.minute)}${house}${retrograde}`);
  }

  return lines;
}

function housesBlock(chart: Chart): string {
  const houses = [...(chart.houses ?? [])].sort((left, right) => left.house - right.house);
  return houses
    .map((house) => `${house.house} ${position(house.sign, house.degree, 0)}`)
    .join(' | ');
}

function aspectsBlock(chart: Chart): string {
  const known = new Set(chart.planets.map((planet) => planet.key));
  const nameOf = new Map(chart.planets.map((planet) => [planet.key, planet.name] as const));

  const sorted = [...chart.aspects]
    .filter((aspect) => known.has(aspect.a) && known.has(aspect.b))
    .sort((left, right) => {
      const byStrength = (right.strength ?? 0) - (left.strength ?? 0);
      if (byStrength !== 0) {
        return byStrength;
      }
      const byOrb = (left.orb ?? 0) - (right.orb ?? 0);
      return byOrb !== 0 ? byOrb : `${left.a}${left.b}`.localeCompare(`${right.a}${right.b}`);
    });

  return sorted
    .map(
      (aspect) =>
        `${nameOf.get(aspect.a) ?? aspect.a} ${ASPECT_NAMES[aspect.type] ?? aspect.type} ` +
        `${nameOf.get(aspect.b) ?? aspect.b} ${strength(aspect.strength)} orb${orb(aspect.orb)}`,
    )
    .join(' | ');
}

function balancesBlock(chart: Chart): string {
  const elements = chart.balances?.elements ?? {};
  const modalities = chart.balances?.modalities ?? {};

  return (
    `fire ${share(elements.fire)} earth ${share(elements.earth)} ` +
    `air ${share(elements.air)} water ${share(elements.water)} | ` +
    `cardinal ${share(modalities.cardinal)} fixed ${share(modalities.fixed)} ` +
    `mutable ${share(modalities.mutable)}`
  );
}

/**
 * `chart_facts` для одного вызова LLM.
 *
 * При `time_precision = unknown` строк `angles` и `houses` нет вовсе — не
 * `null`, а отсутствие: модель не должна пытаться их «вспомнить».
 */
export function serializeChartFacts(chart: Chart): string {
  const precision = chart.birth?.time_precision ?? (chart.birth?.time_known === false ? 'unknown' : 'exact');
  const lines: string[] = [`time_precision: ${precision}`, 'planets:', ...planetsBlock(chart)];

  // Углы и дома существуют только при известном времени.
  if (precision !== 'unknown') {
    if (chart.asc !== null && chart.asc !== undefined) {
      const mc =
        chart.mc === null || chart.mc === undefined
          ? ''
          : ` | mc ${position(chart.mc.sign, chart.mc.degree, chart.mc.minute)}`;
      lines.push(`angles: asc ${position(chart.asc.sign, chart.asc.degree, chart.asc.minute)}${mc}`);
    }

    if (chart.houses !== null && chart.houses !== undefined && chart.houses.length > 0) {
      lines.push(`houses: ${housesBlock(chart)}`);
    }
  }

  const aspects = aspectsBlock(chart);
  if (aspects !== '') {
    lines.push(`aspects (по силе): ${aspects}`);
  }

  lines.push(`balances: ${balancesBlock(chart)}`);

  const omitted = chart.omitted_planets ?? [];
  if (omitted.length > 0) {
    lines.push(`omitted: ${omitted.map((key) => `${key} (не считается)`).join(' | ')}`);
  }

  return lines.join('\n');
}

/**
 * Тот же факт, но без домашних чисел — для `AskResponse.based_on` и логов:
 * только «Луна в Льве, 12-й дом», без градусов и минут.
 */
export function chartFactLabels(chart: Chart): string[] {
  const labels = chart.planets.map((planet) => {
    const house = planet.house === null || planet.house === undefined ? '' : `, ${planet.house}-й дом`;
    const sign = SIGN_PREPOSITIONAL[planet.sign] ?? planet.sign;
    return `${planet.name} в ${sign}${house}`;
  });

  if (chart.asc !== null && chart.asc !== undefined) {
    labels.push(`Асцендент в ${SIGN_PREPOSITIONAL[chart.asc.sign] ?? chart.asc.sign}`);
  }

  return labels;
}
