import { Inject, Injectable, type NestMiddleware } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { JsonLogger } from './logger';
import {
  REQUEST_ID_HEADER,
  peekRequestId,
  requestPath,
  resolveRequestId,
  runWithRequestContext,
} from './request-context';

/**
 * Ставит request_id до разбора тела запроса (QA-12b).
 *
 * Middleware Nest'а выполняется уже после body-parser: битый JSON до него не
 * доходит, и ответ 422 уезжал без `X-Request-Id`, а в `problem.request_id`
 * было `no-request-context` — по такому отчёту инцидент не найти. Поэтому
 * контекст ставится express-middleware до парсера, а Nest-middleware ниже
 * переиспользует уже выданный id и пишет access-лог.
 */
export function applyRequestContext(app: INestApplication): void {
  app.use((req: Request, res: Response, next: NextFunction) => {
    const existing = peekRequestId();
    const requestId = existing ?? resolveRequestId(req.header(REQUEST_ID_HEADER.toLowerCase()));
    res.setHeader(REQUEST_ID_HEADER, requestId);
    if (existing !== undefined) {
      next();
      return;
    }
    runWithRequestContext({ requestId }, () => {
      next();
    });
  });
}

/**
 * Присваивает request_id (или принимает клиентский) и пишет access-лог.
 * Логи — только метод, путь, код и длительность: ни тело, ни query, ни заголовки.
 */
@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  constructor(@Inject(JsonLogger) private readonly logger: JsonLogger) {}

  use(req: Request, res: Response, next: NextFunction): void {
    // id уже выдан до парсера тела; здесь только переиспользуем его.
    const requestId = peekRequestId() ?? resolveRequestId(req.header(REQUEST_ID_HEADER.toLowerCase()));
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
