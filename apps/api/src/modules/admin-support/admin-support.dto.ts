import type { ApiError } from '../../common/api-error';
import { invalidFields, validationFailed } from '../../common/api-error';

/**
 * Разбор тел админских маршрутов волны 40.2 (контракт 1.6.16).
 *
 * Правила, которые здесь зашиты и которые нельзя «упростить» по дороге:
 *
 *   • **суммы возврата в запросе нет вовсе.** `POST /admin/users/{id}/refund`
 *     принимает `charge_id` и `reason`; если в теле встретилось что-то похожее
 *     на сумму (`amount`, `amount_stars`, `stars`, `price_stars`), это `422
 *     refund_amount_not_allowed`, а не «проигнорируем». Возврат всегда полный:
 *     сумма берётся из `payments.total_amount`, а не из запроса, иначе панель
 *     могла бы вернуть половину, а Telegram — нет;
 *   • **неизвестное поле — ошибка.** PATCH цены меняет только цену: `test_only`,
 *     `is_active`, `founder_only` через него не правятся, и «лишнее поле
 *     пришло» должно быть видно панели, а не молча проигнорировано;
 *   • валидация ручная и строгая: это деньги и доступ, и «поле пропущено»
 *     должно быть `422` с именем поля.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `id` из пути — UUID. Проверяется до SQL: `WHERE id = 'привет'` на колонке
 * `uuid` даёт `22P02` и `500`, а «такого пользователя нет» — это `404`.
 */
export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}


/**
 * `422` с машинной причиной **в `details.reason`**.
 *
 * `invalidFields` кладёт в `details` только `field_errors`, а контракт держит
 * причину в `details.reason` (по ней панель различает «нет фильтра» и «два
 * фильтра», а не читает текст). Поэтому здесь собираем оба поля разом.
 */
function invalid(
  reason: string,
  errors: readonly { readonly field: string; readonly message: string }[],
): ApiError {
  return validationFailed({
    reason,
    ...(errors[0] === undefined ? {} : { message: errors[0].message }),
    details: {
      reason,
      field_errors: errors.map(({ field, message }) => ({ field, message })),
    },
  });
}

function asObject(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw invalidFields([{ field: 'body', message: 'Ожидается объект' }]);
  }

  return body as Record<string, unknown>;
}

function rejectUnknown(source: Record<string, unknown>, allowed: readonly string[]): void {
  const unknown = Object.keys(source).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw invalid(
      'unknown_field',
      unknown.map((field) => ({
        field,
        message: `Поле не поддерживается. Разрешены: ${allowed.join(', ')}`,
      })),
    );
  }
}

function readPositiveInt(source: Record<string, unknown>, field: string): number {
  const value = source[field];

  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw invalidFields([{ field, message: 'Целое число больше нуля' }]);
  }

  return value;
}

function readString(source: Record<string, unknown>, field: string, min: number, max: number): string {
  const value = source[field];

  if (typeof value !== 'string') {
    throw invalidFields([{ field, message: `Строка от ${min} до ${max} символов` }]);
  }

  const trimmed = value.trim();

  if (trimmed.length < min || trimmed.length > max) {
    throw invalidFields([{ field, message: `Строка от ${min} до ${max} символов` }]);
  }

  return trimmed;
}

// --- цена и тестовый тариф -------------------------------------------------

/**
 * Тело `PATCH /admin/plans/{code}` (1.6.16 → 1.6.17).
 *
 * Две правки живут в одном маршруте, потому что это один и тот же объект и один
 * и тот же журнал:
 *   • **цена** (`price_stars`) — с оптимистичной проверкой `base_version`, как
 *     раньше: панель со старой вкладки не перетирает чужое изменение;
 *   • **`test_only`** (1.6.17) — то, что нельзя безопасно править в SQL.
 *
 * Почему выключение `test_only` требует второго шага. Тариф с `test_only = true`
 * — это «продаётся за 1 ⭐ только в тестовом режиме». Снять флаг значит
 * **выставить его в продажу по этой цене**: человек заплатит 1 звезду и получит
 * подписку. Опечатка в панели (`false` вместо `true`) стоит денег, и заметить её
 * некому. Поэтому сервер требует `confirm: "disable_test_plan"` — ровно ту
 * строку, которую панель показывает в диалоге. Включение флага подтверждения не
 * требует: оно закрывает тариф, а не открывает.
 *
 * `price_stars` и `test_only` вместе разрешены: это одна транзакция и одна
 * запись аудита.
 */
export interface AdminPlanUpdate {
  /** `null` — цену не меняем. */
  readonly priceStars: number | null;
  /** `null` — флаг не меняем. */
  readonly testOnly: boolean | null;
  /** `confirm: "disable_test_plan"` — обязателен только для `test_only: false`. */
  readonly confirm: string | null;
  readonly comment: string;
  readonly baseVersion: number;
}

/** Строка подтверждения, которую панель присылает второй раз (см. выше). */
export const DISABLE_TEST_PLAN_CONFIRM = 'disable_test_plan';

export function parseAdminPlanUpdate(body: unknown): AdminPlanUpdate {
  const source = asObject(body);
  rejectUnknown(source, ['price_stars', 'test_only', 'confirm', 'comment', 'base_version']);

  const priceStars =
    source['price_stars'] === undefined ? null : readPositiveInt(source, 'price_stars');

  let testOnly: boolean | null = null;
  if (source['test_only'] !== undefined) {
    if (typeof source['test_only'] !== 'boolean') {
      throw invalidFields([{ field: 'test_only', message: 'true или false' }]);
    }
    testOnly = source['test_only'];
  }

  if (priceStars === null && testOnly === null) {
    throw invalid('nothing_to_update', [
      { field: 'body', message: 'Нужно хотя бы одно поле: price_stars или test_only' },
    ]);
  }

  const confirm =
    source['confirm'] === undefined ? null : readString(source, 'confirm', 1, 64);

  return {
    priceStars,
    testOnly,
    confirm,
    comment: readString(source, 'comment', 5, 500),
    baseVersion: readPositiveInt(source, 'base_version'),
  };
}

// --- списки с курсором -----------------------------------------------------

export interface PageLimits {
  readonly defaultLimit: number;
  readonly maxLimit: number;
}

/** `limit` из query: пусто — значение по умолчанию; иначе 1..max. */
export function parseListLimit(value: unknown, limits: PageLimits): number {
  if (value === undefined || value === '') {
    return limits.defaultLimit;
  }

  const limit = typeof value === 'string' ? Number(value) : Number.NaN;
  if (!Number.isInteger(limit) || limit < 1 || limit > limits.maxLimit) {
    throw invalid('invalid_limit', [
      { field: 'limit', message: `От 1 до ${limits.maxLimit}` },
    ]);
  }

  return limit;
}

/**
 * Курсор — непрозрачная строка `base64url(<ISO времени>|<id>)`.
 *
 * Панель не должна ничего знать о формате (иначе «продолжить с этого места»
 * однажды начнут собирать руками), а сервер получает keyset-пагинацию без
 * `OFFSET`: она не съезжает, когда между страницами появилась новая строка.
 */
export interface ListCursor {
  readonly createdAt: Date;
  readonly id: string;
}

export function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}|${id}`, 'utf8').toString('base64url');
}

export function parseCursor(value: unknown): ListCursor | null {
  if (value === undefined || value === '') {
    return null;
  }

  if (typeof value !== 'string') {
    throw invalid('invalid_cursor', [{ field: 'cursor', message: 'Курсор из прошлого ответа' }]);
  }

  const decoded = Buffer.from(value, 'base64url').toString('utf8');
  const separator = decoded.lastIndexOf('|');
  const createdAt = new Date(decoded.slice(0, separator));
  const id = decoded.slice(separator + 1);

  if (separator < 0 || Number.isNaN(createdAt.getTime()) || id === '') {
    throw invalid('invalid_cursor', [{ field: 'cursor', message: 'Курсор из прошлого ответа' }]);
  }

  return { createdAt, id };
}

// --- подтверждение алерта --------------------------------------------------

export interface AdminAlertAck {
  readonly minutes: number;
}

const ACK_MIN_MINUTES = 15;
const ACK_MAX_MINUTES = 1440;

/**
 * `POST /admin/alerts/{id}/ack` — на сколько минут скрыть алерт.
 *
 * Диапазон 15 минут … 24 часа: меньше 15 — «заглушил и не заметил», больше суток
 * — «выключил мониторинг». Подтверждение **не чинит** алерт: оно гасит показ,
 * значение и порог остаются в ответе (это проверяет тест).
 */
export function parseAlertAck(body: unknown): AdminAlertAck {
  const source = asObject(body);
  rejectUnknown(source, ['minutes']);

  const minutes = source['minutes'];
  if (
    typeof minutes !== 'number' ||
    !Number.isInteger(minutes) ||
    minutes < ACK_MIN_MINUTES ||
    minutes > ACK_MAX_MINUTES
  ) {
    throw invalid('invalid_minutes', [
      { field: 'minutes', message: `Целое от ${ACK_MIN_MINUTES} до ${ACK_MAX_MINUTES}` },
    ]);
  }

  return { minutes };
}

/** Границы подтверждения — нужны и в контракте, и в панели, и в тестах. */
export const ALERT_ACK_BOUNDS = {
  min: ACK_MIN_MINUTES,
  max: ACK_MAX_MINUTES,
  default: 60,
} as const;

// --- поиск пользователей ---------------------------------------------------

export type AdminUserSearch =
  | { readonly by: 'telegram_id'; readonly telegramId: bigint }
  | { readonly by: 'alias'; readonly alias: string }
  | { readonly by: 'q'; readonly q: string };

export interface AdminUserQuery {
  readonly telegram_id?: unknown;
  readonly alias?: unknown;
  readonly q?: unknown;
}

/**
 * Ровно один фильтр. Два сразу — `422 invalid_search`, ни одного — тоже:
 * «покажи всех» на таблице с ПДн не должно существовать как режим, даже если
 * ответ и так без ПДн.
 */
export function parseAdminUserSearch(query: AdminUserQuery): AdminUserSearch {
  const present = (['telegram_id', 'alias', 'q'] as const).filter(
    (key) => query[key] !== undefined && query[key] !== '',
  );

  if (present.length !== 1) {
    throw invalid('invalid_search', [
      {
        field: 'search',
        message: 'Нужен ровно один фильтр: telegram_id, alias или q',
      },
    ]);
  }

  const key = present[0] as 'telegram_id' | 'alias' | 'q';
  const raw = query[key];

  if (typeof raw !== 'string') {
    throw invalid('invalid_search', [{ field: key, message: 'Ожидается строка' }]);
  }

  const value = raw.trim();

  if (key === 'telegram_id') {
    if (!/^\d{1,20}$/.test(value)) {
      throw invalid('invalid_search', [{ field: 'telegram_id', message: 'Числовой Telegram ID' }]);
    }
    return { by: 'telegram_id', telegramId: BigInt(value) };
  }

  if (value.length < 2) {
    throw invalid('invalid_search', [{ field: key, message: 'Минимум 2 символа' }]);
  }

  return key === 'alias' ? { by: 'alias', alias: value } : { by: 'q', q: value };
}

// --- возврат ---------------------------------------------------------------

/** Поля, которых в теле возврата быть не должно: сумма — не из запроса. */
const REFUND_FORBIDDEN = [
  'amount',
  'amount_stars',
  'total_amount',
  'stars',
  'price_stars',
  'sum',
  'partial',
] as const;

export interface AdminRefundRequest {
  readonly chargeId: string;
  readonly reason: string;
}

export function parseAdminRefund(body: unknown): AdminRefundRequest {
  const source = asObject(body);

  const forbidden = REFUND_FORBIDDEN.filter((key) => source[key] !== undefined);
  if (forbidden.length > 0) {
    throw invalid(
      'refund_amount_not_allowed',
      forbidden.map((field) => ({
        field,
        message: 'Возврат всегда полный: сумма берётся из платежа, а не из запроса',
      })),
    );
  }

  rejectUnknown(source, ['charge_id', 'reason']);

  return {
    chargeId: readString(source, 'charge_id', 1, 200),
    reason: readString(source, 'reason', 3, 500),
  };
}

// --- бан -------------------------------------------------------------------

export interface AdminBanRequest {
  readonly banned: boolean;
  readonly reason: string;
}

export function parseAdminBan(body: unknown): AdminBanRequest {
  const source = asObject(body);
  rejectUnknown(source, ['banned', 'reason']);

  const banned = source['banned'];
  if (typeof banned !== 'boolean') {
    throw invalidFields([{ field: 'banned', message: 'true или false' }]);
  }

  // Снятие бана причину не требует — но и не запрещает: «разбанен, потому что
  // разобрались» полезнее пустой строки в журнале.
  const reason =
    source['reason'] === undefined && !banned
      ? 'разбанен из панели'
      : readString(source, 'reason', 5, 500);

  return { banned, reason };
}
