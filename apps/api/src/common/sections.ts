/**
 * Работа с текстовыми разделами: предложения, обрезка, сборка markdown.
 *
 * Урок round27/28 живого текста: обрезка по слову рождает обрывки («назовите.»),
 * которые нельзя показывать человеку. Поэтому обрезка здесь — **только по
 * границе предложения**: пока текст длиннее предела, выбрасываем последнее
 * предложение целиком. Предложение, которое само длиннее предела, оставляем
 * как есть и помечаем `length_off`: лучше длиннее, чем обрывок.
 *
 * Модуль общий для прогноза дня и «спроси карту»: механика одна, продуктовые
 * правила (какие разделы, какие запреты) живут в своих валидаторах.
 */

/** Раздел: ключ, заголовок и границы объёма — всё приходит с сервера. */
export interface SectionMeta {
  readonly key: string;
  readonly title: string;
  readonly min: number;
  readonly max: number;
}

export interface TrimResult {
  readonly text: string;
  /** Что-то выбросили, чтобы уложиться в `max`. */
  readonly trimmed: boolean;
  /** Объём всё ещё вне границ (`length_off`). */
  readonly off: boolean;
}

/**
 * Предложения текста. Разделитель — знак конца предложения и пробел после него;
 * многоточие и «!», «?» тоже считаются концом.
 */
export function splitSentences(text: string): string[] {
  return text
    .replace(/\s+/gu, ' ')
    .trim()
    .split(/(?<=[.!?…])\s+/u)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence !== '');
}

/**
 * Обрезка до `max` знаков по границе предложения.
 *
 * `min` нужен только для флага `off`: если после обрезки текст короче минимума,
 * это `length_off`, а не повод приписать выдуманное предложение.
 */
export function trimToSentences(text: string, max: number, min = 0): TrimResult {
  const normalized = text.replace(/\s+/gu, ' ').trim();

  if (normalized.length <= max) {
    return { text: normalized, trimmed: false, off: normalized.length < min };
  }

  const sentences = splitSentences(normalized);
  const kept: string[] = [];

  for (const sentence of sentences) {
    const candidate = [...kept, sentence].join(' ');
    if (candidate.length > max && kept.length > 0) {
      break;
    }
    // Первое предложение кладём даже если оно длиннее предела: пустой раздел
    // хуже длинного, а резать внутри предложения запрещено.
    kept.push(sentence);
  }

  const result = kept.join(' ');
  return { text: result, trimmed: result !== normalized, off: result.length < min || result.length > max };
}

/** Текст кончается знаком конца предложения — то есть это не обрывок. */
export function endsProperly(text: string): boolean {
  return /[.!?…»"']$/u.test(text.trim());
}

/** Разделы в markdown: заголовок второго уровня и текст под ним. */
export function joinSections(
  sections: readonly { readonly title: string; readonly body: string }[],
): string {
  return sections.map((section) => `## ${section.title}\n\n${section.body}`).join('\n\n');
}

/**
 * Обратный разбор markdown-тела. Нужен, чтобы `body_md` в БД был читаемым
 * текстом (его смотрят глазами при разборе инцидента), а не JSON-блобом.
 * Заголовки — наши, из `meta`, поэтому посторонний `##` в тексте не ломает
 * разбор: он попадёт в тело предыдущего раздела.
 */
export function parseSectionsMd(
  body: string,
  meta: readonly SectionMeta[],
): Map<string, string> {
  const titles = new Map(meta.map((section) => [section.title, section.key]));
  const result = new Map<string, string>();
  let currentKey: string | null = null;
  let buffer: string[] = [];

  const flush = (): void => {
    if (currentKey !== null) {
      result.set(currentKey, buffer.join('\n').trim());
    }
    buffer = [];
  };

  for (const line of body.split('\n')) {
    const heading = /^##\s+(.+)$/u.exec(line.trim());
    if (heading !== null) {
      const key = titles.get(heading[1]?.trim() ?? '');
      if (key !== undefined) {
        flush();
        currentKey = key;
        continue;
      }
    }
    buffer.push(line);
  }

  flush();
  return result;
}
