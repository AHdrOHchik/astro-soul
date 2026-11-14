import { Controller, Headers, HttpCode, Inject, Post, Query } from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import { APP_ENV } from '../../config/env.module';
import type { AppEnv } from '../../config/env';
import { forbidden } from '../../common/api-error';
import { JsonLogger } from '../../common/logger';
import { JOB_NAMES, JobsService, type JobName, type JobRunResult } from './jobs.service';

/** Заголовок крона: секрет не в URL, чтобы не оседать в логах прокси. */
const SECRET_HEADER = 'x-jobs-secret';

function safeEqual(expected: string, provided: string | undefined): boolean {
  if (provided === undefined) {
    return false;
  }
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(provided, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * `POST /api/v1/internal/jobs/run` — триггер воркеров (контракт: `security: []`
 * плюс секрет).
 *
 * initData здесь не годится: дергает крон, а не пользователь. Секрет не задан
 * в окружении — маршрут закрыт всегда.
 */
@Controller('internal/jobs')
export class JobsController {
  constructor(
    @Inject(JobsService) private readonly jobs: JobsService,
    @Inject(APP_ENV) private readonly env: AppEnv,
    @Inject(JsonLogger) private readonly logger: JsonLogger,
  ) {}

  @Post('run')
  @HttpCode(202)
  async run(
    @Headers(SECRET_HEADER) secret: string | undefined,
    @Query('job') job?: string,
  ): Promise<JobRunResult> {
    const expected = this.env.INTERNAL_JOB_SECRET;

    if (expected === undefined || !safeEqual(expected, secret)) {
      this.logger.warn('jobs_forbidden', { reason: 'secret_mismatch' });
      throw forbidden({ reason: 'jobs_secret' });
    }

    // `?job=` — у каждого джоба свой таймер (infra/systemd), поэтому имя
    // проверяем по списку, а не пробрасываем как есть.
    const only: JobName | undefined =
      job === undefined ? undefined : JOB_NAMES.find((name) => name === job);
    if (job !== undefined && only === undefined) {
      throw forbidden({ reason: 'unknown_job' });
    }

    const result = await this.jobs.run(only);
    this.logger.info('jobs_run', { ...result });
    return result;
  }
}
