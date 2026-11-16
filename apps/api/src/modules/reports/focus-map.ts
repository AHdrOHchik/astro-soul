import type { SectionKey } from './validators';

/**
 * Распределение фокусов плана по главам — детерминированно, без модели.
 *
 * Проблема, которую решает файл (живой прогон 2026-11-16): план вернул семь
 * фокусов, и каждая глава получала **весь** план. Модель считала, что обязана
 * упомянуть всё, а объём главы — 3–6 абзацев по 2–4 предложения. Физически
 * невыполнимо, и единственный выход, который она находила, — один плотный
 * абзац на все темы. Валидатор это и поймал (`paragraphs: 1 вне 3–6`), но
 * лечить надо было вход, а не выход.
 *
 * Карта «фактор → глава» — из `docs/qa/reports/structure.md` §3 («Карта
 * покрытия: фактор × глава»). Порядок глав в списке — порядок разбора: первая
 * глава, где фактор главный (**Г** в таблице), выигрывает; следующие — запас,
 * если первая уже набрала фокусов. Модель здесь не решает ничего: при одном и
 * том же плане глава всегда получает один и тот же набор.
 */

/** Сколько фокусов глава может получить: больше — снова «конспект». */
export const MAX_FOCUSES_PER_CHAPTER = 3;

/** Главы в порядке разбора. `summary` в распределении не участвует. */
const CHAPTERS: readonly Exclude<SectionKey, 'summary'>[] = [
  'core',
  'emotions',
  'talents',
  'relations',
  'money',
  'purpose',
];

interface FactorRule {
  /** Как фактор назван в плане — человеческим языком или ключом фактов. */
  readonly match: RegExp;
  /** Главы, где фактор главный (**Г**), в порядке разбора. */
  readonly chapters: readonly Exclude<SectionKey, 'summary'>[];
}

/**
 * Строки — в порядке убывания точности: «аспекты Луны» должны сработать
 * раньше, чем «Луна», иначе аспект уедет в главу про эмоции целиком.
 */
const FACTOR_RULES: readonly FactorRule[] = [
  // Аспекты — отдельные строки таблицы §3.
  { match: /аспект\p{L}*\s+(?:к\s+)?солнц|аспект\p{L}*\s+солнца|sun\b.*aspect|aspect.*sun/iu, chapters: ['core'] },
  { match: /аспект\p{L}*\s+(?:к\s+)?лун|аспект\p{L}*\s+луны|moon\b.*aspect|aspect.*moon/iu, chapters: ['emotions'] },
  { match: /аспект\p{L}*\s+(?:к\s+)?венер|venus\b.*aspect|aspect.*venus/iu, chapters: ['relations'] },
  { match: /аспект\p{L}*\s+(?:к\s+)?марс|mars\b.*aspect|aspect.*mars/iu, chapters: ['talents', 'relations'] },
  { match: /аспект|aspect/iu, chapters: ['emotions', 'talents', 'relations', 'money', 'purpose'] },

  // Балансы: стихии и кресты — «как устроен», «что раздражает», «где дорого».
  { match: /стихи|крест|balance/iu, chapters: ['core', 'emotions', 'money'] },

  // Дома и углы: своя строка на каждый дом из таблицы §3.
  { match: /(?:^|[^\d])(?:1|перв)\p{L}*\s*дом|дом\s*(?:1|перв)|house\s*1/iu, chapters: ['core'] },
  { match: /(?:^|[^\d])(?:5|пят)\p{L}*\s*дом|дом\s*(?:5|пят)|house\s*5/iu, chapters: ['talents', 'purpose'] },
  { match: /(?:^|[^\d])(?:6|шест)\p{L}*\s*дом|дом\s*(?:6|шест)|house\s*6/iu, chapters: ['money'] },
  { match: /(?:^|[^\d])(?:7|седьм)\p{L}*\s*дом|дом\s*(?:7|седьм)|house\s*7/iu, chapters: ['relations'] },
  { match: /(?:^|[^\d])(?:8|восьм)\p{L}*\s*дом|дом\s*(?:8|восьм)|house\s*8/iu, chapters: ['relations', 'money'] },
  { match: /(?:^|[^\d])(?:9|девят)\p{L}*\s*дом|дом\s*(?:9|девят)|house\s*9/iu, chapters: ['talents', 'purpose'] },
  { match: /(?:^|[^\d])(?:10|десят)\p{L}*\s*дом|дом\s*(?:10|десят)|house\s*10/iu, chapters: ['money'] },
  { match: /(?:^|[^\d])(?:11|одиннадцат)\p{L}*\s*дом|дом\s*(?:11|одиннадцат)|house\s*11/iu, chapters: ['talents'] },
  { match: /(?:^|[^\d])(?:12|двенадцат)\p{L}*\s*дом|дом\s*(?:12|двенадцат)|house\s*12/iu, chapters: ['emotions', 'relations'] },
  { match: /\bдом\b|house/iu, chapters: ['core', 'money'] },

  // Точки и светила.
  { match: /асцендент|asc\b/iu, chapters: ['core'] },
  { match: /середин\p{L}*\s+неба|\bmc\b|зенит/iu, chapters: ['money'] },
  { match: /солнц|\bsun\b/iu, chapters: ['core', 'money'] },
  { match: /лун|\bmoon\b/iu, chapters: ['emotions', 'core'] },
  { match: /меркури|mercury/iu, chapters: ['talents'] },
  { match: /венер|venus/iu, chapters: ['relations'] },
  { match: /марс|mars/iu, chapters: ['emotions', 'talents', 'relations', 'money'] },
  { match: /юпитер|jupiter/iu, chapters: ['talents', 'money'] },
  { match: /сатурн|saturn/iu, chapters: ['money', 'purpose'] },
  { match: /уран|uranus/iu, chapters: ['talents', 'purpose'] },
  { match: /нептун|neptune/iu, chapters: ['emotions', 'relations', 'money'] },
  { match: /плутон|pluto/iu, chapters: ['relations'] },
  { match: /узел|node/iu, chapters: ['purpose'] },
];

export interface PlanFocus {
  readonly topic?: string;
  readonly factor?: string;
  readonly angle?: string;
}

/** Главы, где этот фактор главный, в порядке разбора; пусто — фактор не опознан. */
export function chaptersForFactor(factor: string | undefined): readonly Exclude<SectionKey, 'summary'>[] {
  if (factor === undefined) {
    return [];
  }
  for (const rule of FACTOR_RULES) {
    if (rule.match.test(factor)) {
      return rule.chapters;
    }
  }
  return [];
}

/**
 * Фокусы одной главы: только её доля плана, не весь план.
 *
 * Если фактор не опознан, фокус достаётся первой главе, у которой ещё есть
 * место, — так он не теряется и не попадает всем шести сразу. Лишние фокусы
 * сверх `MAX_FOCUSES_PER_CHAPTER` отбрасываются: «если тем больше, чем
 * абзацев, выбери 2–3 главные» — это и есть та фраза из промпта, только
 * выполненная кодом.
 */
export function focusesForSection(
  focuses: readonly PlanFocus[],
  key: Exclude<SectionKey, 'summary'>,
): readonly PlanFocus[] {
  const assigned = new Map<Exclude<SectionKey, 'summary'>, PlanFocus[]>(
    CHAPTERS.map((chapter) => [chapter, []]),
  );

  const hasRoom = (chapter: Exclude<SectionKey, 'summary'>): boolean =>
    (assigned.get(chapter)?.length ?? 0) < MAX_FOCUSES_PER_CHAPTER;

  /** Самая свободная глава: так «лишний» фокус не сваливается весь в первую. */
  const leastLoaded = (): Exclude<SectionKey, 'summary'> | undefined =>
    CHAPTERS.filter(hasRoom).sort(
      (left, right) => (assigned.get(left)?.length ?? 0) - (assigned.get(right)?.length ?? 0),
    )[0];

  for (const focus of focuses) {
    const preferred = chaptersForFactor(focus.factor);
    const target = preferred.find(hasRoom) ?? leastLoaded();
    if (target !== undefined) {
      assigned.get(target)?.push(focus);
    }
  }

  return assigned.get(key) ?? [];
}
