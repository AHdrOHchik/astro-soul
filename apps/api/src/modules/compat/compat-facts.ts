/**
 * `compatibility_facts` v1.0 из сайдкара (`packages/astro/astro/synastry.py`)
 * и то, что из них делается для промпта.
 *
 * Здесь нет ни одной даты, координаты или имени: сайдкар их не присылает,
 * а конвейер их и не ждёт. Модель получает углы и следствия, а не биографию.
 */
export const COMPAT_FACTS_VERSION = '1.0';

export interface CrossAspectFact {
  readonly a: string;
  readonly b: string;
  readonly a_name: string;
  readonly b_name: string;
  readonly type: 'conjunction' | 'opposition' | 'trine' | 'square' | 'sextile';
  readonly type_ru: string;
  readonly exact_angle: number;
  readonly aspect_angle: number;
  readonly orb: number;
  readonly strength: number;
  readonly direction: 'applying' | 'separating';
  readonly luminary: boolean;
}

export interface LuminaryFact {
  readonly pair: 'sun-moon' | 'moon-moon' | 'venus-mars' | 'sun-sun';
  readonly present: boolean;
  readonly type: string | null;
  readonly orb: number | null;
  /** Планеты пары: сайдкар присылает их с версии 1.0, но полагаться только на них нельзя. */
  readonly a?: string;
  readonly b?: string;
}

export interface BalancesFact {
  readonly a: { readonly elements: Record<string, number>; readonly modalities: Record<string, number> };
  readonly b: { readonly elements: Record<string, number>; readonly modalities: Record<string, number> };
  readonly delta: {
    readonly elements: Record<string, number>;
    readonly modalities: Record<string, number>;
  };
}

export interface HouseOverlayFact {
  readonly a_in_b: readonly { readonly planet: string; readonly planet_name: string; readonly house: number }[];
  readonly b_in_a: readonly { readonly planet: string; readonly planet_name: string; readonly house: number }[];
}

export interface CompatibilityFacts {
  readonly version: string;
  readonly engine_version: string;
  readonly cross_aspects: readonly CrossAspectFact[];
  readonly luminaries: readonly LuminaryFact[];
  readonly balances: BalancesFact;
  /** Блока нет целиком, если время рождения известно не у обеих карт. */
  readonly house_overlays?: HouseOverlayFact;
}

/**
 * Проверка ответа сайдкара перед работой.
 *
 * Сайдкар — свой, но версия фактов у него своя: если он пришлёт `0.9` или
 * пустой список аспектов, текст соберётся «из ничего» и пройдёт валидаторы
 * (форма-то верная). Поэтому форма проверяется здесь и только здесь, а
 * провал превращается в `error_code = engine`, а не в пустой разбор.
 */
export function parseCompatibilityFacts(value: unknown): CompatibilityFacts {
  if (typeof value !== 'object' || value === null) {
    throw new Error('compat_facts: не объект');
  }

  const facts = value as Partial<CompatibilityFacts>;

  if (facts.version !== COMPAT_FACTS_VERSION) {
    throw new Error(`compat_facts: версия ${String(facts.version)} вместо ${COMPAT_FACTS_VERSION}`);
  }
  if (typeof facts.engine_version !== 'string') {
    throw new Error('compat_facts: нет engine_version');
  }
  if (!Array.isArray(facts.cross_aspects) || facts.cross_aspects.length === 0) {
    // Ноль кросс-аспектов между двумя картами — это не «пара без связей»,
    // а сломанный вход: движок считает 20+ пар планет.
    throw new Error('compat_facts: пустой список кросс-аспектов');
  }
  if (!Array.isArray(facts.luminaries)) {
    throw new Error('compat_facts: нет блока светил');
  }
  const balances = facts.balances;
  if (
    typeof balances !== 'object' ||
    balances === null ||
    typeof balances.a !== 'object' ||
    typeof balances.b !== 'object' ||
    typeof balances.delta !== 'object'
  ) {
    throw new Error('compat_facts: нет баланса стихий');
  }
  if (facts.house_overlays !== undefined) {
    const overlays = facts.house_overlays;
    if (!Array.isArray(overlays.a_in_b) || !Array.isArray(overlays.b_in_a)) {
      throw new Error('compat_facts: битый блок домов');
    }
  }

  return facts as CompatibilityFacts;
}

/** Планеты, чьи оверлеи вообще попадают в факты: светила и личные планеты. */
const OVERLAY_PLANETS = new Set(['sun', 'moon', 'mercury', 'venus', 'mars', 'jupiter', 'saturn']);

/** Дома, которые читаются как «сфера отношений»: 1, 4, 5, 7, 8, 10, 12. */
const OVERLAY_HOUSES = new Set([1, 4, 5, 7, 8, 10, 12]);

const ELEMENT_RU: Readonly<Record<string, string>> = {
  fire: 'огонь',
  earth: 'земля',
  air: 'воздух',
  water: 'вода',
};

const MODALITY_RU: Readonly<Record<string, string>> = {
  cardinal: 'кардинальный крест',
  fixed: 'фиксированный крест',
  mutable: 'мутабельный крест',
};

const PLANET_RU: Readonly<Record<string, string>> = {
  sun: 'Солнце',
  moon: 'Луна',
  mercury: 'Меркурий',
  venus: 'Венера',
  mars: 'Марс',
  jupiter: 'Юпитер',
  saturn: 'Сатурн',
  uranus: 'Уран',
  neptune: 'Нептун',
  pluto: 'Плутон',
};

/** `applying`/`separating` по-русски: в промпте английских слов быть не должно. */
const DIRECTION_RU: Readonly<Record<string, string>> = {
  applying: 'сходящийся',
  separating: 'расходящийся',
};

function signed(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return `${rounded > 0 ? '+' : '−'}${String(Math.abs(rounded)).replace('.', ',')}`;
}

/**
 * Блок фактов для промпта. Строки — по одной мысли: модель не должна
 * разбирать JSON, её работа — переводить готовые углы в человеческий язык.
 */
export function factsBlock(facts: CompatibilityFacts): string {
  const aspects = facts.cross_aspects.slice(0, 10).map(
    (aspect, index) =>
      `${index + 1}. ${aspect.a_name} (ты) — ${aspect.type_ru} — ${aspect.b_name} (партнёр): ` +
      `угол ${aspect.exact_angle}°, орб ${aspect.orb}°, ${DIRECTION_RU[aspect.direction] ?? aspect.direction}`,
  );

  const luminaries = facts.luminaries
    .map((block) =>
      block.present
        ? `${block.pair}: ${block.type ?? ''} (орб ${block.orb ?? 0}°)`
        : `${block.pair}: нет`,
    )
    .join('; ');

  const elements = Object.entries(facts.balances.delta.elements)
    .map(([key, value]) => `${ELEMENT_RU[key] ?? key} ${signed(value)}`)
    .join(', ');
  const modalities = Object.entries(facts.balances.delta.modalities)
    .map(([key, value]) => `${MODALITY_RU[key] ?? key} ${signed(value)}`)
    .join(', ');

  const lines = [
    'Кросс-аспекты (сильнейшие, орб посчитан сайдкаром):',
    ...aspects,
    '',
    `Светила: ${luminaries}.`,
    `Баланс стихий, партнёр минус ты (процентные пункты): ${elements}.`,
    `Баланс крестов, партнёр минус ты (процентные пункты): ${modalities}.`,
  ];

  const overlays = facts.house_overlays;
  if (overlays === undefined) {
    lines.push(
      'Дома не рассчитаны: время рождения известно не у обеих карт. Не упоминай дома вообще.',
    );
  } else {
    const aInB = overlays.a_in_b
      .filter((item) => OVERLAY_PLANETS.has(item.planet) && OVERLAY_HOUSES.has(item.house))
      .map((item) => `${item.planet_name} — ${item.house}`)
      .join(', ');
    const bInA = overlays.b_in_a
      .filter((item) => OVERLAY_PLANETS.has(item.planet) && OVERLAY_HOUSES.has(item.house))
      .map((item) => `${item.planet_name} — ${item.house}`)
      .join(', ');
    lines.push(`Твои планеты в домах партнёра: ${aInB === '' ? 'нет значимых' : aInB}.`);
    lines.push(`Планеты партнёра в твоих домах: ${bInA === '' ? 'нет значимых' : bInA}.`);
  }

  return lines.join('\n');
}

/**
 * Семейство факта из `compatibility_facts` v1.0. Четыре семейства — четыре
 * разных источника: кросс-аспекты, блок светил, разница балансов и оверлеи
 * домов. Раскладка обязана дать каждому семейству место в тексте, иначе
 * раздел «узнавание» собирается из одних аспектов (итерация 23).
 */
export type CompatFamily = 'aspect' | 'luminary' | 'balance' | 'overlay';

/** Факт, который можно распределить по разделам. */
export interface CompatFactor {
  /** Уникальный идентификатор факта: по нему считается лимит «≤ 2 раздела». */
  readonly id: string;
  /** Категория — строка таблицы покрытия (`COMPAT_COVERAGE`). */
  readonly category: string;
  /** Семейство — ради того, чтобы каждое из четырёх попало в текст. */
  readonly family: CompatFamily;
  /** Человеческая формулировка для промпта. */
  readonly label: string;
  /** Меньше — значимее (как `SIGNIFICANCE` в `focus-map.ts` разбора). */
  readonly significance: number;
}

function aspectCategory(aspect: CrossAspectFact): string {
  if (aspect.luminary) {
    return 'aspect_luminary';
  }
  const pair = new Set([aspect.a, aspect.b]);
  if (pair.has('venus') && pair.has('mars')) {
    return 'aspect_venus_mars';
  }
  if (pair.has('mercury') || pair.has('venus') || pair.has('mars')) {
    return 'aspect_personal';
  }
  if (pair.has('saturn') || pair.has('jupiter')) {
    return 'aspect_social';
  }
  return 'aspect_outer';
}

/**
 * Факты пары в порядке значимости.
 *
 * Порядок детерминированный и не зависит от модели: кросс-аспекты идут как их
 * отсортировал сайдкар (по силе), затем балансы, затем оверлеи. Именно из этого
 * списка `distributeSections` набирает разделы, поэтому одинаковые карты
 * всегда дают одинаковый текст.
 */
export function factorsOf(facts: CompatibilityFacts): readonly CompatFactor[] {
  const factors: CompatFactor[] = [];

  /**
   * Пары светил, уже описанные кросс-аспектом (итерация 28).
   *
   * Ключ — пара без направления: «моё Солнце — его Луна» и «моя Луна — его
   * Солнце» астрологически разные, но для промпта это одна и та же тема, и
   * дважды её повторять не надо.
   */
  const luminaryPairs = new Set<string>();
  const pairOf = (a: string, b: string): string => [a, b].sort().join('-');

  for (const aspect of facts.cross_aspects) {
    // Светила — это семейство `luminary`, а не подпись к аспектам.
    //
    // Раньше семейство собиралось только из четырёх фиксированных пар блока
    // `luminaries`, и живой прогон `46d8b893` показал дыру: все четыре пары
    // пришли `present: false`, хотя в `cross_aspects` светила были
    // (Венера–Луна, Юпитер–Солнце, Солнце–Марс). Семейство `luminary`
    // оказывалось пустым ровно там, где на нём держится раздел «Что
    // совпадает», — то есть у тизера продукта.
    const luminary = aspect.luminary === true;
    if (luminary) {
      luminaryPairs.add(pairOf(aspect.a, aspect.b));
    }
    factors.push({
      // Префикс идентификатора повторяет семейство: по нему в отчёте видно,
      // что светило пришло из аспекта, а не из блока `luminaries`.
      id: luminary ? `luminary:aspect:${aspect.a}-${aspect.b}` : `aspect:${aspect.a}-${aspect.b}`,
      category: aspectCategory(aspect),
      family: luminary ? 'luminary' : 'aspect',
      label: `${aspect.a_name} — ${aspect.type_ru} — ${aspect.b_name}, орб ${aspect.orb}°`,
      significance: luminary ? 1 : 4,
    });
  }

  // Блок светил — отдельное семейство, а не подпись под аспектами: сайдкар
  // считает его по своей формуле, и в тексте он звучит своей фразой. Но если
  // та же пара уже пришла кросс-аспектом, второй раз её не повторяем.
  for (const block of facts.luminaries) {
    if (!block.present) {
      continue;
    }
    const [pairA = '', pairB = ''] = block.pair.split('-');
    const a = PLANET_RU[block.a ?? pairA] ?? (block.a ?? pairA);
    const b = PLANET_RU[block.b ?? pairB] ?? (block.b ?? pairB);
    if (luminaryPairs.has(pairOf(block.a ?? pairA, block.b ?? pairB))) {
      continue;
    }
    factors.push({
      id: `luminary:${block.pair}`,
      category: 'luminary',
      family: 'luminary',
      label: `${a} (ты) — ${block.type ?? 'аспект'} — ${b} (партнёр), орб ${block.orb ?? 0}°`,
      significance: 1,
    });
  }

  for (const [key, value] of Object.entries(facts.balances.delta.elements)) {
    if (Math.abs(value) < 8) {
      continue;
    }
    factors.push({
      id: `balance:element:${key}`,
      category: 'balance_element',
      family: 'balance',
      label: `Разница по стихии «${ELEMENT_RU[key] ?? key}»: ${signed(value)} п.п.`,
      significance: 7,
    });
  }

  for (const [key, value] of Object.entries(facts.balances.delta.modalities)) {
    if (Math.abs(value) < 8) {
      continue;
    }
    factors.push({
      id: `balance:cross:${key}`,
      category: 'balance_cross',
      family: 'balance',
      label: `Разница по кресту «${MODALITY_RU[key] ?? key}»: ${signed(value)} п.п.`,
      significance: 8,
    });
  }

  const overlays = facts.house_overlays;
  if (overlays !== undefined) {
    for (const direction of ['a_in_b', 'b_in_a'] as const) {
      for (const item of overlays[direction]) {
        if (!OVERLAY_PLANETS.has(item.planet) || !OVERLAY_HOUSES.has(item.house)) {
          continue;
        }
        const whose = direction === 'a_in_b' ? 'твоя планета в доме партнёра' : 'планета партнёра в твоём доме';
        factors.push({
          id: `overlay:${direction}:${item.planet}:${item.house}`,
          category: 'overlay',
          family: 'overlay',
          label: `${item.planet_name} — ${whose}, ${item.house}-й дом`,
          // Светила в домах партнёра читаются сильнее, чем Сатурн.
          significance: item.planet === 'sun' || item.planet === 'moon' ? 2 : 5,
        });
      }
    }
  }

  return factors;
}

/**
 * Подпись факта для промпта раздела. Позиция — устойчивая: по ней модель
 * видит «свой» факт списком, а не абзацем.
 */
export function factorLine(factor: CompatFactor, position: number): string {
  return `${position + 1}. ${factor.label}`;
}
