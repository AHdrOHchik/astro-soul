import { Controller, Get, Inject } from '@nestjs/common';
import type { HealthResponse } from '@astro-soul/shared';
import { DbService } from '../../db/db.service';
import { APP_ENV } from '../../config/env.module';
import type { AppEnv } from '../../config/env';
import { AstroClient } from '../astro/astro.client';

/** Единственный публичный маршрут `/api/v1/*` (контракт: `security: []`). */
@Controller('health')
export class HealthController {
  constructor(
    @Inject(DbService) private readonly db: DbService,
    @Inject(AstroClient) private readonly astro: AstroClient,
    @Inject(APP_ENV) private readonly env: AppEnv,
  ) {}

  @Get()
  async health(): Promise<HealthResponse> {
    const [dbOk, astroState] = await Promise.all([this.db.ping(), this.astro.health()]);

    return {
      // Сайдкар движка — часть работоспособности: без него не строятся карты.
      status: dbOk && astroState === 'ok' ? 'ok' : 'degraded',
      version: this.env.APPLICATION_VERSION,
      db: dbOk ? 'ok' : 'down',
      // Клиента LLM ещё нет (итерация «LLM-конвейер») — честно `unknown`.
      llm: 'unknown',
      astro: astroState,
    };
  }
}
