import type { components } from './schema.gen';

export type Problem = components['schemas']['Problem'];
export type ProblemCode = Problem['code'];
export type FieldError = components['schemas']['FieldError'];
/** Failures that happen before a readable answer arrives. Not part of the API contract. */
export type ClientErrorCode = 'NETWORK' | 'TIMEOUT' | 'INVALID_RESPONSE';
export type ApiErrorCode = ProblemCode | ClientErrorCode;

/** Typed against the contract: a code added to or removed from `Problem.code` breaks the build here. */
const PROBLEM_CODES: Record<ProblemCode, true> = {
  UNAUTHORIZED: true,
  FORBIDDEN: true,
  NOT_FOUND: true,
  CONFLICT: true,
  VALIDATION_FAILED: true,
  QUOTA_EXCEEDED: true,
  PAYMENT_REQUIRED: true,
  RATE_LIMITED: true,
  INTERNAL: true,
  UPSTREAM_LLM: true,
  GEO_NOT_FOUND: true,
};

/**
 * For answers without a Problem body, e.g. from a proxy in front of the API. Only the
 * statuses the contract ties to a single code. 400 is not one of them: the API never
 * answers with it, so a bare 400 says nothing about the user's input.
 */
const CODE_BY_STATUS: Partial<Record<number, ProblemCode>> = {
  401: 'UNAUTHORIZED',
  402: 'PAYMENT_REQUIRED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  422: 'VALIDATION_FAILED',
  429: 'RATE_LIMITED',
};

export interface ApiErrorInfo {
  /** HTTP status; absent when no response was received. */
  status?: number;
  /** `Problem.message`: written by the server for the user, in Russian. */
  serverMessage?: string;
  /** `Problem.request_id`: lets support find the request in logs. */
  requestId?: string;
  details?: Record<string, unknown>;
}

export class ApiError extends Error {
  override readonly name = 'ApiError';
  readonly code: ApiErrorCode;
  readonly status: number | undefined;
  readonly serverMessage: string | undefined;
  readonly requestId: string | undefined;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: ApiErrorCode, info: ApiErrorInfo = {}) {
    super(info.status === undefined ? code : `${code} (HTTP ${info.status})`);
    this.code = code;
    this.status = info.status;
    this.serverMessage = info.serverMessage;
    this.requestId = info.requestId;
    this.details = info.details;
  }
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}

/** True for a request cancelled by the caller (unmount, newer search query). Not worth showing. */
export function isAbortError(error: unknown): boolean {
  return isRecord(error) && error.name === 'AbortError';
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFieldError(value: unknown): value is FieldError {
  return isRecord(value) && typeof value.field === 'string' && typeof value.message === 'string' && value.message.trim() !== '';
}

/**
 * `details.field_errors` of a `VALIDATION_FAILED` answer: which request fields the
 * server rejected and its text for each, in the order it checked them. Empty for
 * any other error and when the server named no fields.
 */
export function fieldErrorsOf(error: unknown): FieldError[] {
  if (!isApiError(error) || error.code !== 'VALIDATION_FAILED') return [];
  const list = error.details?.field_errors;
  return Array.isArray(list) ? list.filter(isFieldError) : [];
}

function isProblemCode(value: unknown): value is ProblemCode {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(PROBLEM_CODES, value);
}

/**
 * `Problem.message` is written for the user, in Russian. A text without a single
 * Cyrillic letter is something else, e.g. what a proxy or a server framework says
 * on its own ("Cannot POST /api/v1/…"): not for the screen.
 */
const RUSSIAN_TEXT = /\p{Script=Cyrillic}/u;

/** The server's own words for the user, when it sent any that can be shown. */
export function serverTextOf(error: unknown): string | undefined {
  const text = isApiError(error) ? error.serverMessage : undefined;
  return text !== undefined && RUSSIAN_TEXT.test(text) ? text : undefined;
}

/**
 * What the server says about a request it rejected: its text for the first field it
 * names, else its message. A 422 comes in either form, with `details.field_errors`
 * or as a bare Problem, and both are read here.
 */
export function rejectionTextOf(error: unknown): string | undefined {
  const [first] = fieldErrorsOf(error);
  return first !== undefined && RUSSIAN_TEXT.test(first.message) ? first.message : serverTextOf(error);
}

/** `details.reset_at`: when the limit the request ran into lifts, if the server says so. */
export function resetAtOf(error: unknown): Date | undefined {
  const value = isApiError(error) ? error.details?.reset_at : undefined;
  if (typeof value !== 'string') return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/**
 * What an event may say about a failure: the HTTP status when the server answered,
 * the client's own code when it did not. Never the server's text.
 */
export function failureCodeOf(error: unknown): string {
  if (!isApiError(error)) return 'INTERNAL';
  return error.status === undefined ? error.code : String(error.status);
}

/**
 * Builds the error for a non-2xx answer: by `Problem.code` when present, by status otherwise.
 * `headerRequestId` is the `X-Request-Id` header: the same id as `Problem.request_id`, and
 * the only one there is when the answer has no Problem body.
 */
export function errorFromResponse(status: number, body: unknown, headerRequestId?: string | null): ApiError {
  const problem = isRecord(body) ? body : {};
  const { code, message, request_id: bodyRequestId, details } = problem;
  const requestId = typeof bodyRequestId === 'string' && bodyRequestId !== '' ? bodyRequestId : headerRequestId;
  return new ApiError(isProblemCode(code) ? code : (CODE_BY_STATUS[status] ?? 'INTERNAL'), {
    status,
    serverMessage: typeof message === 'string' && message.trim() !== '' ? message : undefined,
    requestId: typeof requestId === 'string' && requestId !== '' ? requestId : undefined,
    details: isRecord(details) ? details : undefined,
  });
}
