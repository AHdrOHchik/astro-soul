/*
 * Копирование в буфер. Отдельный модуль потому, что `navigator.clipboard`
 * отсутствует не «иногда», а по правилам: он живёт только в безопасном контексте
 * (https или localhost). Открыть панель по http://10.0.0.5:5199 — и кнопка
 * перестанет работать; это надо показать текстом, а не тихим ничегонеделанием.
 *
 * Запасного варианта через `document.execCommand('copy')` здесь нет намеренно:
 * он помечен как deprecated и в новых браузерах молча возвращает false —
 * «скопировано» после такого было бы враньем.
 */

export type CopyOutcome = 'copied' | 'unsupported' | 'denied';

export async function copyText(value: string, clipboard?: Clipboard): Promise<CopyOutcome> {
  if (value === '') return 'unsupported';
  if (!clipboard || typeof clipboard.writeText !== 'function') return 'unsupported';

  try {
    await clipboard.writeText(value);
    return 'copied';
  } catch {
    // Запрос буфера мог быть отклонён пользователем или политикой браузера.
    return 'denied';
  }
}

export function copyFallback(target: HTMLElement): string {
  // Выделяем текст: дальше человек жмёт Ctrl+C сам. Ничего не утверждаем.
  const selection = window.getSelection();
  if (!selection) return 'denied';
  const range = document.createRange();
  range.selectNodeContents(target);
  selection.removeAllRanges();
  selection.addRange(range);
  return 'unsupported';
}
