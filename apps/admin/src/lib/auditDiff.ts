/*
 * «Было → стало» в журнале аудита. Сервер кладёт в `before`/`after` только
 * изменённые поля, поэтому панель ничего не вычисляет: она сводит два снимка
 * по union'у ключей и показывает разницу. Пустые значения не рисуются пустыми
 * ячейками — для них есть «—».
 */

import { EMPTY } from './format';

export type AuditSnapshot = { readonly [key: string]: unknown } | null | undefined;

export interface AuditDiffRow {
  readonly field: string;
  readonly from: string;
  readonly to: string;
}

function cell(value: unknown): string {
  if (value === null || value === undefined) return EMPTY;
  if (typeof value === 'string') return value === '' ? EMPTY : value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    // Циклическая ссылка в снимке — не повод ронять строку журнала.
    return EMPTY;
  }
}

/**
 * Строки различий: ключи union'а, по алфавиту (порядок не должен зависеть от
 * серверной сериализации). Если различий нет — пустой список, экран поставит
 * «—» сам.
 */
export function auditDiffs(before: AuditSnapshot, after: AuditSnapshot): readonly AuditDiffRow[] {
  const keys = new Set<string>([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  return [...keys]
    .sort()
    .map((field) => ({ field, from: cell(before?.[field]), to: cell(after?.[field]) }));
}

/** Служебная запись (уборка сессий) — не действие человека: `actor_tg_id = '0'`. */
export function isServiceActor(actorTgId: string): boolean {
  return actorTgId === '0';
}
