import { Catch, Inject, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import type { Request, Response } from 'express';
import { JsonLogger } from './logger';
import { currentRequestId } from './request-context';
import { ApiError } from './api-error';
import { toProblem } from './problem-response';

/** Единая точка формирования ошибок: `application/problem+json` + request_id. */
@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  constructor(@Inject(JsonLogger) private readonly logger: JsonLogger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();
    const requestId = currentRequestId();
    const { status, problem } = toProblem(exception, requestId);

    const logFields = {
      method: req.method,
      // без query: подписанные ссылки в лог не попадают
      path: req.originalUrl.split('?')[0] ?? req.path,
      status,
      code: problem.code,
      ...(exception instanceof ApiError
        ? { reason: exception.reason, ...exception.logFields }
        : {}),
    };

    if (status >= 500) {
      this.logger.error('request_failed', {
        ...logFields,
        error: exception instanceof Error ? exception : String(exception),
      });
    } else {
      this.logger.warn('request_rejected', logFields);
    }

    if (res.headersSent) {
      return;
    }

    res.status(status).type('application/problem+json').json(problem);
  }
}
