import type { ProblemCode } from '@astro-soul/shared';
import { PROBLEM_MESSAGES } from '../i18n/ru';

export interface ApiErrorOptions {
  /** Переопределить HTTP-статус (например, 422 вместо 400 для VALIDATION_FAILED). */
  readonly status?: number;
  /** Машинная причина для логов и details. ПДн сюда не попадают. */
  readonly reason?: string;
  readonly details?: Readonly<Record<string, unknown>>;
  /** Переопределить пользовательский текст (по умолчанию — из i18n). */
  readonly message?: string;
  /** Дополнительные поля для лога (без ПДн). */
  readonly logFields?: Readonly<Record<string, unknown>>;
}

/** Единый формат ошибки API (`Problem` в контракте). */
export class ApiError extends Error {
  readonly code: ProblemCode;
  readonly status: number;
  readonly reason: string | undefined;
  readonly details: Readonly<Record<string, unknown>> | undefined;
  readonly logFields: Readonly<Record<string, unknown>> | undefined;

  constructor(code: ProblemCode, status: number, options: ApiErrorOptions = {}) {
    super(options.message ?? PROBLEM_MESSAGES[code]);
    this.name = 'ApiError';
    this.code = code;
    this.status = options.status ?? status;
    this.reason = options.reason;
    this.details = options.details;
    this.logFields = options.logFields;
  }
}

export function unauthorized(options: ApiErrorOptions = {}): ApiError {
  return new ApiError('UNAUTHORIZED', 401, options);
}

export function notFound(options: ApiErrorOptions = {}): ApiError {
  return new ApiError('NOT_FOUND', 404, options);
}

/**
 * `VALIDATION_FAILED` — всегда 422 (контракт 1.2.1, отчёт фронта).
 * 400 в API не используется вовсе.
 */
export function validationFailed(options: ApiErrorOptions = {}): ApiError {
  return new ApiError('VALIDATION_FAILED', 422, options);
}

/** Ошибка конкретного поля — фронт подсвечивает его по `field`. */
export interface FieldErrorInput {
  readonly field: string;
  readonly message: string;
}

/**
 * `422 VALIDATION_FAILED` со списком полей.
 * Первое сообщение становится текстом ошибки, весь список — в `details.field_errors`.
 */
export function invalidFields(
  errors: readonly FieldErrorInput[],
  options: Omit<ApiErrorOptions, 'details'> = {},
): ApiError {
  const first = errors[0];
  return new ApiError('VALIDATION_FAILED', 422, {
    ...options,
    ...(first === undefined ? {} : { message: first.message }),
    details: { field_errors: errors.map(({ field, message }) => ({ field, message })) },
  });
}

export function internalError(options: ApiErrorOptions = {}): ApiError {
  return new ApiError('INTERNAL', 500, options);
}

export function conflict(options: ApiErrorOptions = {}): ApiError {
  return new ApiError('CONFLICT', 409, options);
}

export function forbidden(options: ApiErrorOptions = {}): ApiError {
  return new ApiError('FORBIDDEN', 403, options);
}

export function rateLimited(options: ApiErrorOptions = {}): ApiError {
  return new ApiError('RATE_LIMITED', 429, options);
}
