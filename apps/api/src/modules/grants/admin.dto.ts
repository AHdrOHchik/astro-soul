import type { GrantKind } from '@astro-soul/shared';
import { invalidFields } from '../../common/api-error';

/**
 * Разбор тел админских маршрутов выдачи (1.6.14).
 *
 * Валидация нарочно ручная и строгая: это ручная выдача денег, и «поле
 * пропущено» должно быть `422` с именем поля, а не «дни по умолчанию».
 * Ни одно из значений не ПДн: `user_id` — псевдоним, `days` и `kind` — числа и
 * перечисления.
 */

const GRANT_KINDS: readonly GrantKind[] = ['all_access', 'single_report', 'single_compat'];

function asObject(body: unknown, field: string): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw invalidFields([{ field, message: 'Ожидается объект' }]);
  }

  return body as Record<string, unknown>;
}

function readString(source: Record<string, unknown>, field: string): string {
  const value = source[field];

  if (typeof value !== 'string' || value.trim() === '') {
    throw invalidFields([{ field, message: 'Обязательное поле' }]);
  }

  return value;
}

function readKind(source: Record<string, unknown>): GrantKind {
  const value = source['kind'];

  if (typeof value !== 'string' || !GRANT_KINDS.includes(value as GrantKind)) {
    throw invalidFields([
      { field: 'kind', message: `Одно из: ${GRANT_KINDS.join(', ')}` },
    ]);
  }

  return value as GrantKind;
}

export interface AdminGrantCreate {
  readonly user_id: string;
  readonly kind: GrantKind;
  readonly days: number | null;
  readonly action: 'issue' | 'revoke';
  readonly grant_id: string;
}

export function parseAdminGrantCreate(body: unknown): AdminGrantCreate {
  const source = asObject(body, 'body');
  const action = source['action'] === 'revoke' ? 'revoke' : 'issue';
  const kind = readKind(source);
  const userId = readString(source, 'user_id');

  if (action === 'revoke') {
    // Для отзыва `kind` нужен только чтобы ответ был одинаковой формы; сам
    // отзыв ищет строку по `grant_id` и `user_id` (чужое право не отозвать).
    return {
      user_id: userId,
      kind,
      days: null,
      action,
      grant_id: readString(source, 'grant_id'),
    };
  }

  const rawDays = source['days'];

  if (kind === 'all_access') {
    const days = typeof rawDays === 'number' ? rawDays : Number(rawDays);

    if (!Number.isInteger(days) || days <= 0 || days > 3650) {
      throw invalidFields([{ field: 'days', message: 'Целое число дней от 1 до 3650' }]);
    }

    return { user_id: userId, kind, days, action, grant_id: '' };
  }

  // Для одноразовых прав дни не имеют смысла: молча игнорировать их нельзя,
  // иначе админ «выдаст разбор на 30 дней» и будет ждать, что он истечёт.
  if (rawDays !== undefined && rawDays !== null) {
    throw invalidFields([{ field: 'days', message: 'Дни задаются только для all_access' }]);
  }

  return { user_id: userId, kind, days: null, action, grant_id: '' };
}

export interface AdminCodeCreate {
  readonly kind: GrantKind;
  readonly days: number | null;
  readonly maxActivations: number;
  readonly partnerName: string | null;
  readonly expiresAt: Date | null;
}

/**
 * `POST /admin/codes`: `{kind, days?, max_activations, partner_name?, expires_at?}`.
 *
 * `max_activations` обязателен: код «на всех» без счётчика — это и есть
 * бесконтрольная раздача, из-за которой появился бюджет.
 */
export function parseAdminCodeCreate(body: unknown): AdminCodeCreate {
  const source = asObject(body, 'body');
  const kind = readKind(source);

  const rawMax = source['max_activations'];
  const maxActivations = typeof rawMax === 'number' ? rawMax : Number(rawMax);

  if (!Number.isInteger(maxActivations) || maxActivations <= 0 || maxActivations > 100_000) {
    throw invalidFields([
      { field: 'max_activations', message: 'Целое число от 1 до 100000' },
    ]);
  }

  let days: number | null = null;

  if (kind === 'all_access') {
    const rawDays = source['days'];
    days = typeof rawDays === 'number' ? rawDays : Number(rawDays);

    if (!Number.isInteger(days) || days <= 0 || days > 3650) {
      throw invalidFields([{ field: 'days', message: 'Целое число дней от 1 до 3650' }]);
    }
  }

  const partnerName = source['partner_name'];
  if (partnerName !== undefined && partnerName !== null && typeof partnerName !== 'string') {
    throw invalidFields([{ field: 'partner_name', message: 'Строка или null' }]);
  }

  const rawExpires = source['expires_at'];
  let expiresAt: Date | null = null;

  if (rawExpires !== undefined && rawExpires !== null) {
    if (typeof rawExpires !== 'string') {
      throw invalidFields([{ field: 'expires_at', message: 'Дата ISO-8601 или null' }]);
    }

    const parsed = new Date(rawExpires);

    if (Number.isNaN(parsed.getTime())) {
      throw invalidFields([{ field: 'expires_at', message: 'Дата ISO-8601 или null' }]);
    }

    expiresAt = parsed;
  }

  return {
    kind,
    days,
    maxActivations,
    partnerName: typeof partnerName === 'string' && partnerName !== '' ? partnerName : null,
    expiresAt,
  };
}
