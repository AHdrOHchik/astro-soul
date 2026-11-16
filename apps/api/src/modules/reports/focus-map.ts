import type { SectionKey } from './validators';

/**
 * Карта покрытия «фактор × глава» — **детерминированное** распределение
 * `focuses` плана по главам.
 *
 * Источник: `docs/qa/reports/structure.md` §3 «Карта покрытия: фактор × глава»
 * (строка 177 и далее), роль фактора в главе — **Г** (главный) или **у**
 * (под своим углом). Здесь та же таблица, переписанная как данные: модель
 * распределение не решает, иначе одна и та же карта давала бы разные планы.
 *
 * Зачем: живой прогон 16.11.2026 дал план из семи `focuses`, и каждая глава
 * получала все семь. Семь тем в 3–6 абзацев по 2–4 предложения не
 * укладываются, модель сжимала их в один плотный абзац — валидатор
 * (`paragraphs: 1 вне 3–6`) сработал верно. Теперь глава получает свою долю:
 * 2–3 фокуса, у которых этот фактор главный или уместный.
 */

/** Шесть содержательных глав: «Итог» пишется по сводкам, а не по фокусам. */
export type ContentSection = Exclude<SectionKey, 'summary'>;

export type FactorRole = 'main' | 'angle';

/** Порядок глав фиксирован: он же порядок разбора и порядок разрешения ничьих. */
export const CONTENT_SECTIONS: readonly ContentSection[] = [
  'core',
  'emotions',
  'talents',
  'relations',
  'money',
  'purpose',
];

/** Сколько фокусов получает глава. Больше трёх — снова «упомяни всё». */
export const CHAPTER_FOCUS_MIN = 2;
export const CHAPTER_FOCUS_MAX = 3;

/**
 * Жёсткий лимит: один фактор звучит максимум в трёх главах
 * (`structure.md` §3.1). Считается любое упоминание — и «главным» (Г), и
 * «под углом» (у).
 *
 * Зачем: живые прогоны 18.11.2026 дали «мотор» разбора почти во всех главах —
 * квадрат Меркурия к Юпитеру в 6 из 7 глав на `3 Ultra`, Марс секстиль
 * Юпитер в 5 из 6 на `2 Max`. Человек читал не разбор из семи глав, а один
 * тезис, пересказанный семь раз, причём три главы начинались одинаково.
 * Дефект воспроизвёлся на двух моделях, значит дело не в модели.
 */
export const MAX_CHAPTERS_PER_FACTOR = 3;

/**
 * Иерархия значимости (`structure.md` §4): при конфликте берётся следующий
 * по значимости фактор, а не повторяется сильнейший. Меньше число — главнее.
 * Правило редакционное: выше = конкретнее для человека.
 */
export const SIGNIFICANCE: Readonly<Record<string, number>> = {
  // 1. Солнце и Луна (и их аспекты) — скелет разбора.
  sun_sign: 1,
  sun_house: 1,
  moon_sign: 1,
  moon_house: 1,
  aspects_sun: 1,
  aspects_moon: 1,
  // 2. Асцендент, MC и планеты в 1-м доме.
  ascendant: 2,
  house_1: 2,
  mc: 2,
  // 3–5. Управитель Асцендента, стеллиум, аспекты к углам — бэкенд пока не
  // отдаёт отдельными строками, шаг пропускается молча (§4).
  // 6. Самые сильные аспекты между планетами.
  aspects_mercury: 6,
  aspects_venus: 6,
  aspects_mars: 6,
  aspects_outer: 6,
  // 7. Балансы стихий и крестов — фон и темп, не единственный аргумент.
  balances_elements: 7,
  balances_crosses: 7,
  // 8. Дома — уточнение сферы, а не основа вывода.
  house_5: 8,
  house_6: 8,
  house_7: 8,
  house_8: 8,
  house_9: 8,
  house_10: 8,
  house_11: 8,
  house_12: 8,
  // Точность времени — служебная строка, идёт последней.
  time_precision: 9,
  // Планеты без знака/дома в строке §3: между скелетом и аспектами.
  sun: 1,
  moon: 1,
  mercury: 4,
  venus: 4,
  mars: 4,
  jupiter: 4,
  saturn: 4,
  uranus: 4,
  neptune: 4,
  pluto: 4,
  node: 4,
};

/** Значимость фактора: неизвестное считается самым слабым. */
export function significanceOf(row: string): number {
  return SIGNIFICANCE[row] ?? 10;
}

/** Роли фактора по главам: `main` — «Г», `angle` — «у». */
export type CoverageRoles = Readonly<Partial<Record<ContentSection, FactorRole>>>;

/**
 * Таблица `structure.md` §3, строка в строку (32 строки, порядок тот же).
 * `main` — «Г», `angle` — «у». Факторы, которых нет ни в одной главе (`·`),
 * в строке просто отсутствуют.
 */
export const COVERAGE: Readonly<Record<string, CoverageRoles>> = {
  sun_sign: { core: 'main', emotions: 'angle', money: 'angle', purpose: 'angle' },
  sun_house: { core: 'main', money: 'main', purpose: 'angle' },
  moon_sign: { core: 'main', emotions: 'main', relations: 'angle' },
  moon_house: { core: 'main', emotions: 'main' },
  mercury: { talents: 'main', core: 'angle', relations: 'angle', money: 'angle' },
  venus: { relations: 'main', emotions: 'angle', talents: 'angle', money: 'angle' },
  mars: {
    emotions: 'main',
    talents: 'main',
    relations: 'main',
    money: 'main',
    purpose: 'angle',
  },
  jupiter: { talents: 'main', money: 'main', purpose: 'angle' },
  saturn: { money: 'main', talents: 'angle', relations: 'angle', purpose: 'angle' },
  uranus: { talents: 'angle', money: 'angle', purpose: 'angle' },
  neptune: { emotions: 'angle', relations: 'angle', money: 'angle' },
  pluto: { relations: 'main', core: 'angle', emotions: 'angle' },
  node: { purpose: 'main', talents: 'angle', relations: 'angle' },
  ascendant: { core: 'main', emotions: 'angle', purpose: 'angle' },
  mc: { money: 'main', core: 'angle', purpose: 'angle' },
  house_1: { core: 'main', emotions: 'angle' },
  house_5: { talents: 'angle', purpose: 'angle' },
  house_6: { talents: 'angle', money: 'main' },
  house_7: { relations: 'main', emotions: 'angle' },
  house_8: { relations: 'angle', money: 'angle' },
  house_9: { talents: 'angle', purpose: 'angle' },
  house_10: { money: 'main', core: 'angle', purpose: 'angle' },
  house_11: { talents: 'angle', money: 'angle' },
  house_12: { emotions: 'angle', relations: 'angle' },
  aspects_sun: { core: 'main', talents: 'angle', money: 'angle' },
  aspects_moon: { core: 'main', emotions: 'main', relations: 'angle' },
  aspects_venus: { relations: 'main', talents: 'angle' },
  aspects_mars: { relations: 'main', emotions: 'angle', talents: 'angle', money: 'angle' },
  aspects_outer: {
    core: 'angle',
    emotions: 'angle',
    talents: 'angle',
    relations: 'angle',
    money: 'angle',
    purpose: 'angle',
  },
  balances_elements: {
    core: 'main',
    emotions: 'main',
    talents: 'angle',
    money: 'main',
    purpose: 'angle',
  },
  balances_crosses: { core: 'main', emotions: 'angle', money: 'main', purpose: 'angle' },
  time_precision: { core: 'main' },
};

/** Планеты в порядке «сначала узел»: «Лунный узел» не должен стать Луной. */
const PLANETS: readonly { readonly id: string; readonly pattern: RegExp }[] = [
  { id: 'node', pattern: /узел|узл[аеу]|кету/u },
  { id: 'pluto', pattern: /плутон/u },
  { id: 'neptune', pattern: /нептун/u },
  { id: 'uranus', pattern: /уран/u },
  { id: 'saturn', pattern: /сатурн/u },
  { id: 'jupiter', pattern: /юпитер/u },
  { id: 'mars', pattern: /марс/u },
  { id: 'venus', pattern: /венер/u },
  { id: 'mercury', pattern: /меркури/u },
  { id: 'moon', pattern: /лун[аыуео]/u },
  { id: 'sun', pattern: /солнц|солнце/u },
];

/** Внешние планеты в §3 идут одной строкой «Аспекты внешних планет». */
const OUTER = new Set(['uranus', 'neptune', 'pluto', 'saturn', 'jupiter']);

const ASPECT = /аспект|трин|квадрат|оппозиц|соединен|секстил|квиконс|параллел|точк[аи]\s+равновесия/u;

const HOUSES: readonly { readonly id: string; readonly pattern: RegExp }[] = [
  { id: 'house_1', pattern: /(?:^|[^\p{L}\p{N}])1(?!\d)|перв\p{L}*\s+дом/u },
  { id: 'house_5', pattern: /(?:^|[^\p{L}\p{N}])5(?!\d)|пят\p{L}*\s+дом/u },
  { id: 'house_6', pattern: /(?:^|[^\p{L}\p{N}])6(?!\d)|шест\p{L}*\s+дом/u },
  { id: 'house_7', pattern: /(?:^|[^\p{L}\p{N}])7(?!\d)|седьм\p{L}*\s+дом/u },
  { id: 'house_8', pattern: /(?:^|[^\p{L}\p{N}])8(?!\d)|восьм\p{L}*\s+дом/u },
  { id: 'house_9', pattern: /(?:^|[^\p{L}\p{N}])9(?!\d)|девят\p{L}*\s+дом/u },
  { id: 'house_10', pattern: /(?:^|[^\p{L}\p{N}])10(?!\d)|десят\p{L}*\s+дом/u },
  { id: 'house_11', pattern: /(?:^|[^\p{L}\p{N}])11(?!\d)|одиннадцат\p{L}*\s+дом/u },
  { id: 'house_12', pattern: /(?:^|[^\p{L}\p{N}])12(?!\d)|двенадцат\p{L}*\s+дом/u },
];

const HOUSE_WORD = /дом(?:а|е|у|ом|ах|ов)?(?!ой|ашн)|куспид/u;
const ASCENDANT = /асцендент|asc/u;
const MC = /mc|середин\p{L}*\s+неба|зенит/u;
const ELEMENTS = /стихи|баланс\p{L}*\s+(?:вод|огн|земл|воздух)|вод[аыуе]\s+\d|огн[яеё]\s+\d|земл[ияю]\s+\d|воздух\p{L}*\s+\d/u;
const CROSSES = /крест/u;

function normalize(text: string): string {
  return text.toLowerCase().replace(/ё/gu, 'е');
}

/**
 * Факторы, которые фокус называет. Смотрим `factor`, `topic` и `angle`:
 * модель пишет фактор буквально, но слово «аспект» иногда остаётся в теме.
 */
export function factorRows(focusText: string): readonly string[] {
  const text = normalize(focusText);
  const rows = new Set<string>();
  const hasAspect = ASPECT.test(text);

  for (const planet of PLANETS) {
    if (!planet.pattern.test(text)) {
      continue;
    }
    if (hasAspect) {
      rows.add(OUTER.has(planet.id) ? 'aspects_outer' : `aspects_${planet.id}`);
      continue;
    }
    // В §3 у большинства планет одна строка («Меркурий»), у Солнца и Луны —
    // две (знак и дом). Если частной строки нет, берём общую: иначе
    // «Меркурий в 11-м доме» остался бы без роли вовсе.
    const specific = HOUSE_WORD.test(text) ? `${planet.id}_house` : `${planet.id}_sign`;
    rows.add(COVERAGE[specific] === undefined ? planet.id : specific);
  }

  if (ASCENDANT.test(text)) {
    rows.add('ascendant');
  }
  if (MC.test(text)) {
    rows.add('mc');
  }
  if (HOUSE_WORD.test(text)) {
    for (const house of HOUSES) {
      if (house.pattern.test(text)) {
        rows.add(house.id);
      }
    }
  }
  if (CROSSES.test(text)) {
    rows.add('balances_crosses');
  } else if (ELEMENTS.test(text)) {
    rows.add('balances_elements');
  }
  if (/точность времени|time_precision|время рождения/u.test(text)) {
    rows.add('time_precision');
  }

  return [...rows];
}

/** Что это за фокус с точки зрения карты — для логов и отчёта QA. */
export interface PlanFocus {
  readonly topic?: string;
  readonly factor?: string;
  readonly angle?: string;
}

export interface AssignedFocus extends PlanFocus {
  /** Номер в плане (с нуля): по нему видно, какой фокус куда ушёл. */
  readonly index: number;
  /** Факторы строки §3, по которым фокус попал в главу. */
  readonly rows: readonly string[];
}

export interface FocusDistribution {
  readonly byChapter: Readonly<Record<ContentSection, readonly AssignedFocus[]>>;
  readonly counts: Readonly<Record<ContentSection, number>>;
  /** Фокусы, которые не привязались ни к одной строке §3 (их видно в логе). */
  readonly unmapped: readonly number[];
  /**
   * Главы, которым не хватило факторов под лимит (0–1 фокус). Их видно в
   * логе `report_focus_starved`: это сигнал, что план узкий, а не что глава
   * «сломалась».
   */
  readonly starved: readonly ContentSection[];
}

function scoreOf(focus: AssignedFocus, chapter: ContentSection): number {
  let score = 0;
  for (const row of focus.rows) {
    const role = COVERAGE[row]?.[chapter];
    if (role === 'main') {
      score += 2;
    } else if (role === 'angle') {
      score += 1;
    }
  }
  return score;
}

/**
 * Раскладывает фокусы плана по главам.
 *
 * Правила (все детерминированные):
 *   1. **Один фактор — максимум три главы** (`MAX_CHAPTERS_PER_FACTOR`).
 *      Это жёсткий инвариант: как только фактор исчерпал три главы, фокус,
 *      который его называет, в четвёртую главу не идёт.
 *   2. Кандидаты главы сортируются по силе связи с главой (роль «Г» сильнее
 *      «у»), при равенстве — по значимости фактора (§4), при равенстве —
 *      по номеру в плане. Поэтому при конфликте берётся следующий по
 *      значимости фактор, а не повторяется сильнейший.
 *   3. В главе 2–3 фокуса. Если кандидатов не хватает по лимиту — глава
 *      получает два (или меньше), но **никогда** копию исчерпанного фактора:
 *      лучше меньше тем, чем одна и та же мысль в седьмой раз.
 *
 * Ничья разрешается порядком глав в `CONTENT_SECTIONS` и номером фокуса в
 * плане — то есть одинаковый план всегда даёт одинаковое распределение.
 */
export function distributeFocuses(focuses: readonly PlanFocus[]): FocusDistribution {
  const prepared: AssignedFocus[] = focuses.map((focus, index) => ({
    index,
    ...(focus.topic === undefined ? {} : { topic: focus.topic }),
    ...(focus.factor === undefined ? {} : { factor: focus.factor }),
    ...(focus.angle === undefined ? {} : { angle: focus.angle }),
    rows: factorRows([focus.topic, focus.factor, focus.angle].filter((part) => part !== undefined).join(' ')),
  }));

  const byChapter = {} as Record<ContentSection, AssignedFocus[]>;
  const counts = {} as Record<ContentSection, number>;

  // Сколько глав уже используют каждый фактор: по этому счётчику и работает
  // лимит. Считаем на старте по всем главам разом, чтобы распределение не
  // зависело от порядка обхода.
  const usedBy = new Map<string, Set<ContentSection>>();
  const useOf = (row: string): Set<ContentSection> => {
    const existing = usedBy.get(row);
    if (existing !== undefined) {
      return existing;
    }
    const created = new Set<ContentSection>();
    usedBy.set(row, created);
    return created;
  };

  // Фактор, уже звучащий в этой главе через другой фокус, второй раз не
  // берём: три фокуса про один аспект внутри одной главы — та же калька,
  // только в миниатюре (так ведёт себя план, где модель повторила «мотор»).
  const duplicateInChapter = (focus: AssignedFocus, chosen: readonly AssignedFocus[]): boolean =>
    chosen.some((item) => item.rows.some((row) => focus.rows.includes(row)));

  const canTake = (focus: AssignedFocus, chapter: ContentSection, chosen: readonly AssignedFocus[]): boolean =>
    !duplicateInChapter(focus, chosen) &&
    focus.rows.every((row) => {
      const users = useOf(row);
      return users.has(chapter) || users.size < MAX_CHAPTERS_PER_FACTOR;
    });

  for (const chapter of CONTENT_SECTIONS) {
    const candidates = prepared
      .map((focus) => ({ focus, score: scoreOf(focus, chapter) }))
      .filter((item) => item.score > 0)
      .sort(
        (a, b) =>
          b.score - a.score ||
          Math.min(...a.focus.rows.map(significanceOf)) - Math.min(...b.focus.rows.map(significanceOf)) ||
          a.focus.index - b.focus.index,
      )
      .map((item) => item.focus);

    const chosen: AssignedFocus[] = [];

    // Сначала — свои факторы под лимитом, в порядке значимости.
    for (const focus of candidates) {
      if (chosen.length >= CHAPTER_FOCUS_MAX) {
        break;
      }
      if (chosen.some((item) => item.index === focus.index)) {
        continue;
      }
      if (!canTake(focus, chapter, chosen)) {
        continue;
      }
      chosen.push(focus);
    }

    // Добираем до минимума только теми фокусами, что ещё не исчерпали
    // лимит: копия исчерпанного фактора — ровно тот дефект, который чиним.
    if (chosen.length < CHAPTER_FOCUS_MIN) {
      for (const focus of prepared) {
        if (chosen.length >= CHAPTER_FOCUS_MIN) {
          break;
        }
        if (chosen.some((item) => item.index === focus.index)) {
          continue;
        }
        if (!canTake(focus, chapter, chosen)) {
          continue;
        }
        chosen.push(focus);
      }
    }

    for (const focus of chosen) {
      for (const row of focus.rows) {
        useOf(row).add(chapter);
      }
    }

    chosen.sort((a, b) => a.index - b.index);
    byChapter[chapter] = chosen;
    counts[chapter] = chosen.length;
  }

  const unmapped = prepared.filter((focus) => focus.rows.length === 0).map((focus) => focus.index);
  const starved = CONTENT_SECTIONS.filter((chapter) => counts[chapter] < CHAPTER_FOCUS_MIN);

  return { byChapter, counts, unmapped: [...unmapped], starved };
}

/** Матрица «фактор × глава»: по ней видно, сколько глав держится на факторе. */
export interface FactorMatrixRow {
  readonly factor: string;
  readonly chapters: readonly ContentSection[];
  readonly count: number;
}

/**
 * Строки матрицы для отчёта и теста. Фактор попадает в строку, если хотя бы
 * один фокус с этим фактором ушёл в главу. `count > MAX_CHAPTERS_PER_FACTOR`
 * — нарушение инварианта, его ловит тест.
 */
export function factorMatrix(distribution: FocusDistribution): readonly FactorMatrixRow[] {
  const rows = new Map<string, Set<ContentSection>>();

  for (const chapter of CONTENT_SECTIONS) {
    for (const focus of distribution.byChapter[chapter]) {
      for (const row of focus.rows) {
        const set = rows.get(row) ?? new Set<ContentSection>();
        set.add(chapter);
        rows.set(row, set);
      }
    }
  }

  return [...rows.entries()]
    .map(([factor, chapters]) => ({
      factor,
      chapters: CONTENT_SECTIONS.filter((chapter) => chapters.has(chapter)),
      count: chapters.size,
    }))
    .sort((a, b) => significanceOf(a.factor) - significanceOf(b.factor) || a.factor.localeCompare(b.factor));
}

/** Строка фокуса для промпта главы: та же форма, что была у общего блока. */
export function focusLine(focus: AssignedFocus, position: number): string {
  return [
    `${position + 1}.`,
    focus.topic ?? 'тема',
    focus.factor === undefined ? '' : `(фактор: ${focus.factor})`,
    focus.angle === undefined ? '' : `— ${focus.angle}`,
  ]
    .filter((part) => part !== '')
    .join(' ');
}

/**
 * `{{focus_block}}` для конкретной главы: только её фокусы, 2–3 строки.
 *
 * Пустой блок — не поломка: план узкий, и лимит «фактор ≤ 3 главы» не дал
 * этой главе своей темы. Тогда глава строится на фактах карты и правилах
 * главы, и это сказано в промпте прямо, чтобы модель не добирала тему
 * пересказом соседних глав.
 */
export function focusBlockFor(distribution: FocusDistribution, chapter: ContentSection): string {
  const lines = distribution.byChapter[chapter].map((focus, position) => focusLine(focus, position));
  if (lines.length === 0) {
    return 'Своих фокусов у этой главы нет: опирайся на факты карты и правила главы, не пересказывай темы других глав.';
  }
  return lines.join('\n');
}
