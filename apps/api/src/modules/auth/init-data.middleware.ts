import { Inject, Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { APP_ENV } from '../../config/env.module';
import type { AppEnv } from '../../config/env';
import { JsonLogger } from '../../common/logger';
import { currentRequestId, requestPath } from '../../common/request-context';
import { sendProblemResponse } from '../../common/problem-response';
import { INIT_DATA_HEADER, verifyInitData, type VerifiedInitData } from './init-data';
import { isPublicPath } from './public-routes';

/** Request с проверенными данными Telegram. */
export interface AuthenticatedRequest extends Request {
  initData: VerifiedInitData;
}

/**
 * Middleware авторизации: любой `/api/v1/*` кроме `/health` требует валидный
 * initData. Ошибка форматируется здесь же, чтобы не зависеть от того,
 * дошли ли мы до Nest-обработчика.
 */
@Injectable()
export class InitDataMiddleware implements NestMiddleware {
  constructor(
    @Inject(APP_ENV) private readonly env: AppEnv,
    @Inject(JsonLogger) private readonly logger: JsonLogger,
  ) {}

  use(req: Request, res: Response, next: NextFunction): void {
    const path = requestPath(req);

    if (req.method === 'OPTIONS' || isPublicPath(path)) {
      next();
      return;
    }

    try {
      const verified = verifyInitData(req.header(INIT_DATA_HEADER), this.env.TELEGRAM_BOT_TOKEN);
      (req as AuthenticatedRequest).initData = verified;
      next();
    } catch (error) {
      const requestId = currentRequestId();
      this.logger.warn('init_data_rejected', {
        path,
        reason: error instanceof Error ? error.message : String(error),
      });
      sendProblemResponse(res, error, requestId);
    }
  }
}
