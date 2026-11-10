import type { components } from './schema.gen';

export type Problem = components['schemas']['Problem'];
export type ProblemCode = Problem['code'];
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

/** For answers without a Problem body (the contract describes one for only a few responses). */
const CODE_BY_STATUS: Partial<Record<number, ProblemCode>> = {
  400: 'VALIDATION_FAILED',
  401: 'UNAUTHORIZED',
  402: 'PAYMENT_REQUIRED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
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

function isProblemCode(value: unknown): value is ProblemCode {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(PROBLEM_CODES, value);
}

/** Builds the error for a non-2xx answer: by `Problem.code` when present, by status otherwise. */
export function errorFromResponse(status: number, body: unknown): ApiError {
  const problem = isRecord(body) ? body : {};
  const { code, message, request_id: requestId, details } = problem;
  return new ApiError(isProblemCode(code) ? code : (CODE_BY_STATUS[status] ?? 'INTERNAL'), {
    status,
    serverMessage: typeof message === 'string' && message.trim() !== '' ? message : undefined,
    requestId: typeof requestId === 'string' && requestId !== '' ? requestId : undefined,
    details: isRecord(details) ? details : undefined,
  });
}
