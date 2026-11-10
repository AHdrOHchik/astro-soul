import type { ProblemCode } from '@astro-soul/shared';
import { PROBLEM_MESSAGES } from '../i18n/ru';

export interface ApiErrorOptions {
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
    this.status = status;
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

export function validationFailed(options: ApiErrorOptions = {}): ApiError {
  return new ApiError('VALIDATION_FAILED', 400, options);
}

export function internalError(options: ApiErrorOptions = {}): ApiError {
  return new ApiError('INTERNAL', 500, options);
}
