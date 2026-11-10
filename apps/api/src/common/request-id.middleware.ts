import { Inject, Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { JsonLogger } from './logger';
import {
  REQUEST_ID_HEADER,
  requestPath,
  resolveRequestId,
  runWithRequestContext,
} from './request-context';

/**
 * Присваивает request_id (или принимает клиентский) и пишет access-лог.
 * Логи — только метод, путь, код и длительность: ни тело, ни query, ни заголовки.
 */
@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  constructor(@Inject(JsonLogger) private readonly logger: JsonLogger) {}

  use(req: Request, res: Response, next: NextFunction): void {
    const requestId = resolveRequestId(req.header(REQUEST_ID_HEADER.toLowerCase()));
    res.setHeader(REQUEST_ID_HEADER, requestId);

    const startedAt = process.hrtime.bigint();

    runWithRequestContext({ requestId }, () => {
      res.on('finish', () => {
        const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
        this.logger.info('http_request', {
          method: req.method,
          // path без query: подписанный ?sig= в лог не попадает
          path: requestPath(req),
          status: res.statusCode,
          duration_ms: Math.round(durationMs * 10) / 10,
        });
      });

      next();
    });
  }
}
