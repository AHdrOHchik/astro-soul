import { Controller, Get, Inject } from '@nestjs/common';
import type { HealthResponse } from '@astro-soul/shared';
import { DbService } from '../../db/db.service';
import { APP_ENV } from '../../config/env.module';
import type { AppEnv } from '../../config/env';
import { AstroClient } from '../astro/astro.client';
import { TelegramWebhookService } from '../telegram/telegram-webhook.service';

/** Единственный публичный маршрут `/api/v1/*` (контракт: `security: []`). */
@Controller('health')
export class HealthController {
  constructor(
    @Inject(DbService) private readonly db: DbService,
    @Inject(AstroClient) private readonly astro: AstroClient,
    @Inject(APP_ENV) private readonly env: AppEnv,
    @Inject(TelegramWebhookService) private readonly webhook: TelegramWebhookService,
  ) {}

  @Get()
  async health(): Promise<HealthResponse> {
    const [dbOk, astroState] = await Promise.all([this.db.ping(), this.astro.health()]);

    // Состояние вебхука — из последней проверки при старте/диагностике
    // (итерация 26). `stale` значит «не проверяли или проверка старше суток»:
    // это не «всё хорошо» и не «всё плохо», а «не знаем, перезапусти и проверь».
    const webhook = this.webhook.health();

    return {
      // Сайдкар движка — часть работоспособности: без него не строятся карты.
      status: dbOk && astroState === 'ok' ? 'ok' : 'degraded',
      version: this.env.APPLICATION_VERSION,
      db: dbOk ? 'ok' : 'down',
      // Клиента LLM ещё нет (итерация «LLM-конвейер») — честно `unknown`.
      llm: 'unknown',
      astro: astroState,
      telegram_webhook: webhook.state,
    };
  }
}
