import { HttpException } from '@nestjs/common';
import type { Problem, ProblemCode } from '@astro-soul/shared';
import { ApiError } from './api-error';
import { PROBLEM_MESSAGES } from '../i18n/ru';
import { REQUEST_ID_HEADER } from './request-context';

export interface ProblemPayload {
  readonly status: number;
  readonly problem: Problem;
}

/**
 * Единственные разрешённые пары «HTTP-статус → код» (контракт 1.2.1):
 * `VALIDATION_FAILED` — всегда 422 (400 в API не используется), `CONFLICT` — 409.
 * Всё, что пришло от фреймворка, приводится к этой таблице.
 */
const HTTP_STATUS_TO_CODE: Readonly<Record<number, ProblemCode>> = {
  400: 'VALIDATION_FAILED',
  401: 'UNAUTHORIZED',
  402: 'PAYMENT_REQUIRED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  // Метод для существующего пути: пользователю это «страницы нет», а не «запрещено».
  405: 'NOT_FOUND',
  409: 'CONFLICT',
  413: 'VALIDATION_FAILED',
  415: 'VALIDATION_FAILED',
  422: 'VALIDATION_FAILED',
  429: 'RATE_LIMITED',
  500: 'INTERNAL',
  502: 'UPSTREAM_LLM',
  503: 'INTERNAL',
  504: 'INTERNAL',
};

/** Нормализованный статус: `VALIDATION_FAILED` не бывает 400, `NOT_FOUND` — 405. */
function normalizeStatus(status: number, code: ProblemCode): number {
  if (code === 'VALIDATION_FAILED') {
    return 422;
  }
  if (status === 405) {
    return 404;
  }
  return status;
}

/**
 * Приводит любое исключение к телу `Problem`. Единственное место,
 * где формируется ответ об ошибке (единый формат — требование SPEC).
 *
 * Текст берётся из i18n, а не из `exception.message`: иначе наружу утекают
 * английские строки фреймворка вида «Cannot POST /api/v1/geo/resolve».
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
    const rawStatus = exception.getStatus();
    const code = HTTP_STATUS_TO_CODE[rawStatus] ?? (rawStatus >= 500 ? 'INTERNAL' : 'VALIDATION_FAILED');
    const status = normalizeStatus(rawStatus, code);

    return {
      status,
      problem: {
        code,
        message: PROBLEM_MESSAGES[code],
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
