import { HttpException } from '@nestjs/common';
import type { Problem, ProblemCode } from '@astro-soul/shared';
import { ApiError } from './api-error';
import { PROBLEM_MESSAGES } from '../i18n/ru';
import { REQUEST_ID_HEADER } from './request-context';

export interface ProblemPayload {
  readonly status: number;
  readonly problem: Problem;
}

const HTTP_STATUS_TO_CODE: Readonly<Record<number, ProblemCode>> = {
  400: 'VALIDATION_FAILED',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  405: 'FORBIDDEN',
  409: 'VALIDATION_FAILED',
  413: 'VALIDATION_FAILED',
  415: 'VALIDATION_FAILED',
  422: 'VALIDATION_FAILED',
  429: 'RATE_LIMITED',
  500: 'INTERNAL',
  502: 'UPSTREAM_LLM',
  503: 'INTERNAL',
  504: 'INTERNAL',
};

/**
 * Приводит любое исключение к телу `Problem`. Единственное место,
 * где формируется ответ об ошибке (единый формат — требование SPEC).
 */
export function toProblem(exception: unknown, requestId: string): ProblemPayload {
  if (exception instanceof ApiError) {
    return {
      status: exception.status,
      problem: {
        code: exception.code,
        message: exception.message,
        request_id: requestId,
        ...(exception.details === undefined ? {} : { details: exception.details }),
      },
    };
  }

  if (exception instanceof HttpException) {
    const status = exception.getStatus();
    const code = HTTP_STATUS_TO_CODE[status] ?? (status >= 500 ? 'INTERNAL' : 'VALIDATION_FAILED');

    return {
      status,
      problem: {
        code,
        message: code === 'INTERNAL' ? PROBLEM_MESSAGES.INTERNAL : exception.message,
        request_id: requestId,
      },
    };
  }

  return {
    status: 500,
    problem: {
      code: 'INTERNAL',
      message: PROBLEM_MESSAGES.INTERNAL,
      request_id: requestId,
    },
  };
}

export interface ProblemResponse {
  status(code: number): ProblemResponse;
  setHeader(name: string, value: string): unknown;
  type(value: string): ProblemResponse;
  json(body: Problem): unknown;
}

/** Отдаёт `application/problem+json` с заголовком X-Request-Id. */
export function sendProblemResponse(
  res: ProblemResponse,
  exception: unknown,
  requestId: string,
): void {
  const { status, problem } = toProblem(exception, requestId);
  res.setHeader(REQUEST_ID_HEADER, requestId);
  res.status(status).type('application/problem+json').json(problem);
}
