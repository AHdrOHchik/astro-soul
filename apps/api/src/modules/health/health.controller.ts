import { Controller, Get, Inject } from '@nestjs/common';
import type { HealthResponse } from '@astro-soul/shared';
import { DbService } from '../../db/db.service';
import { APP_ENV } from '../../config/env.module';
import type { AppEnv } from '../../config/env';

/** Единственный публичный маршрут `/api/v1/*` (контракт: `security: []`). */
@Controller('health')
export class HealthController {
  constructor(
    @Inject(DbService) private readonly db: DbService,
    @Inject(APP_ENV) private readonly env: AppEnv,
  ) {}

  @Get()
  async health(): Promise<HealthResponse> {
    const dbOk = await this.db.ping();

    return {
      status: dbOk ? 'ok' : 'degraded',
      version: this.env.APPLICATION_VERSION,
      db: dbOk ? 'ok' : 'down',
      // Клиента LLM ещё нет (итерация «LLM-конвейер»), поэтому честно `unknown`.
      llm: 'unknown',
    };
  }
}
