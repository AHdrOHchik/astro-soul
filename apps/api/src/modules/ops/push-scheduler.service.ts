import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { DbService } from '../../db/db.service';
import { APP_ENV } from '../../config/env.module';
import type { AppEnv } from '../../config/env';
import { JsonLogger } from '../../common/logger';
import { EngagementService } from '../engagement/engagement.service';
import { PUSH_LOCK } from './jobs.service';

/**
 * Планировщик утреннего пуша (итерация 38, контракт 1.6.13).
 *
 * Почему минута, а не час. Окно отправки — 08:00–08:04 по поясу рождения, и
 * попасть в него часовым тиком невозможно: у людей в одном часовом поясе окно
 * длиной пять минут, и «запуск раз в час» либо стреляет в 08:00 у всех сразу
 * (совпало), либо не стреляет вовсе. Поэтому тик раз в минуту, а решение
 * «кому пора» принимает SQL: он же и разносит один и тот же тик по поясам.
 *
 * Почему не только внешний крон. `POST /internal/jobs/run?job=forecast_push`
 * остаётся — им удобно дёрнуть цикл руками. Но если пуш зависит **только** от
 * внешнего крона, то его поломка (нет systemd-таймера, опечатка в URL) тихая:
 * люди просто перестают получать сообщения. Внутренний таймер делает планировщик
 * частью процесса, а `/health.flags.push.last_run_at` — видимым снаружи.
 *
 * Три защиты от «двух рассылок одновременно»:
 *   1. `PUSH_ENABLED !== '1'` — таймер не создаётся вовсе;
 *   2. флаг `running` в процессе — тик не накладывается сам на себя;
 *   3. advisory-лок `PUSH_LOCK` в БД — второй инстанс API проигрывает гонку.
 */
@Injectable()
export class PushSchedulerService implements OnModuleInit, OnModuleDestroy {
  /** Как часто просыпается таймер. Ровно минута — размер окна не больше 60. */
  static readonly TICK_MS = 60_000;

  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    @Inject(DbService) private readonly db: DbService,
    @Inject(EngagementService) private readonly engagement: EngagementService,
    @Inject(APP_ENV) private readonly env: AppEnv,
    @Inject(JsonLogger) private readonly logger: JsonLogger,
  ) {}

  onModuleInit(): void {
    if (this.env.PUSH_ENABLED !== '1') {
      // Выключенный флаг — «функции нет», а не «есть и молчит»: иначе `/health`
      // показывал бы живого планировщика у выключенной функции.
      return;
    }

    if (this.env.NODE_ENV === 'test') {
      // В тестах время двигают вызовом `runPush(at)`: фоновый таймер сделал бы
      // результат теста зависимым от того, успел ли он сработать.
      return;
    }

    this.timer = setInterval(() => {
      void this.tick();
    }, PushSchedulerService.TICK_MS);
    // Таймер не должен держать процесс живым при `app.close()`.
    this.timer.unref();

    this.logger.info('push_scheduler_started', { tick_ms: PushSchedulerService.TICK_MS });
  }

  onModuleDestroy(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Один тик. Никогда не бросает: исключение внутри `setInterval` уронило бы
   * процесс, а «пуш не ушёл» — не повод.
   */
  async tick(now: Date = new Date()): Promise<void> {
    if (this.running) {
      this.logger.warn('push_tick_skipped', { reason: 'already_running' });
      return;
    }

    this.running = true;

    try {
      const result = await this.db.withAdvisoryLock(PUSH_LOCK, () =>
        this.engagement.runPush(now),
      );

      if (result === null) {
        this.logger.warn('push_tick_skipped', { reason: 'lock_busy' });
      }
    } catch (error) {
      this.logger.error('push_tick_failed', {
        reason: error instanceof Error ? error.name : 'unknown',
      });
    } finally {
      this.running = false;
    }
  }
}
