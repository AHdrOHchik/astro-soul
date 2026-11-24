/*
 * Ошибка API. Формат тела — `application/problem+json` (контракт: `Problem`),
 * где `message` уже готов к показу: переписывать его панель не имеет права,
 * иначе «что сказал сервер» и «что увидел админ» разойдутся.
 *
 * Кодовые ошибки клиента (`NETWORK`, `TIMEOUT`, `CSRF_MISSING`,
 * `ROUTE_NOT_IN_CONTRACT`) добавлены здесь же: экран обязан различать «сервер
 * отказал» и «мы не спросили, потому что маршрута нет».
 */

export const CLIENT_ERROR_CODES = ['NETWORK', 'TIMEOUT', 'INVALID_RESPONSE', 'CSRF_MISSING', 'ROUTE_NOT_IN_CONTRACT'] as const;

export type ClientErrorCode = (typeof CLIENT_ERROR_CODES)[number];

export interface FieldError {
  readonly field: string;
  readonly message: string;
}

export interface ApiErrorInit {
  readonly code: string;
  readonly status: number | null;
  readonly message: string;
  readonly requestId?: string | null;
  readonly reason?: string | null;
  readonly fieldErrors?: readonly FieldError[];
  readonly route?: string;
  /** `details.retry_after` из ответа `429` — секунды до новой попытки. */
  readonly retryAfterSeconds?: number | null;
}

export class ApiError extends Error {
  readonly code: string;
  readonly status: number | null;
  readonly requestId: string | null;
  readonly reason: string | null;
  readonly fieldErrors: readonly FieldError[];
  readonly route: string | undefined;
  readonly retryAfterSeconds: number | null;

  constructor(init: ApiErrorInit) {
    super(init.message);
    this.name = 'ApiError';
    this.code = init.code;
    this.status = init.status;
    this.requestId = init.requestId ?? null;
    this.reason = init.reason ?? null;
    this.fieldErrors = init.fieldErrors ?? [];
    this.route = init.route;
    this.retryAfterSeconds = init.retryAfterSeconds ?? null;
  }

  get isUnauthorized(): boolean {
    return this.status === 401 || this.code === 'UNAUTHORIZED';
  }

  /**
   * «Маршрута нет в этой версии». Ставится только клиентским гейтом
   * (`assertCallable`) — серверный `404` на существующем маршруте это другой
   * случай («нет строки», например `grant_not_found`), и притворяться
   * «маршрута нет» он не имеет права.
   */
  get isMissingRoute(): boolean {
    return this.code === 'ROUTE_NOT_IN_CONTRACT';
  }

  get isForbidden(): boolean {
    return this.status === 403 || this.code === 'FORBIDDEN';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function fieldErrorsOf(details: unknown): readonly FieldError[] {
  if (!isRecord(details) || !Array.isArray(details.field_errors)) return [];
  const out: FieldError[] = [];
  for (const item of details.field_errors) {
    if (!isRecord(item)) continue;
    const field = asString(item.field);
    const message = asString(item.message);
    if (field && message) out.push({ field, message });
  }
  return out;
}

export interface ParsedProblem {
  readonly code: string;
  readonly message: string;
  readonly reason: string | null;
  readonly fieldErrors: readonly FieldError[];
  readonly retryAfterSeconds: number | null;
}

export function parseProblem(body: unknown): ParsedProblem | null {
  if (!isRecord(body)) return null;
  const code = asString(body.code);
  const message = asString(body.message);
  if (!code || !message) return null;
  const details = isRecord(body.details) ? body.details : undefined;
  const retry = details?.retry_after;
  return {
    code,
    message,
    reason: asString(details?.reason),
    fieldErrors: fieldErrorsOf(body.details),
    retryAfterSeconds: typeof retry === 'number' && Number.isFinite(retry) && retry >= 0 ? Math.ceil(retry) : null,
  };
}

export function errorFromResponse(status: number, body: unknown, requestId: string | null, route: string): ApiError {
  const problem = parseProblem(body);
  return new ApiError({
    code: problem?.code ?? 'INTERNAL',
    status,
    message: problem?.message ?? `Сервер ответил ${status}`,
    requestId,
    reason: problem?.reason ?? null,
    fieldErrors: problem?.fieldErrors ?? [],
    route,
    retryAfterSeconds: problem?.retryAfterSeconds ?? null,
  });
}

export function clientError(code: ClientErrorCode, message: string, route: string, requestId: string | null = null): ApiError {
  return new ApiError({ code, status: null, message, requestId, route });
}

export function toApiError(error: unknown, route: string): ApiError {
  if (error instanceof ApiError) return error;
  if (error instanceof DOMException && error.name === 'AbortError') {
    return clientError('TIMEOUT', 'Запрос не дошёл за отведённое время.', route);
  }
  return clientError('NETWORK', error instanceof Error ? error.message : String(error), route);
}
