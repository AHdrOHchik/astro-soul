import { Controller, Get, Inject, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { HealthResponse } from '@astro-soul/shared';
import { DbService } from '../../db/db.service';
import { APP_ENV } from '../../config/env.module';
import type { AppEnv } from '../../config/env';
import { AstroClient } from '../astro/astro.client';
import { TelegramWebhookService } from '../telegram/telegram-webhook.service';
import { BonusBudgetService } from '../grants/bonus-budget.service';

/**
 * Единственный публичный маршрут `/api/v1/*` (контракт: `security: []`).
 *
 * Итерация 36 добавила в ответ три вещи, без которых `/health` не годится для
 * внешнего мониторинга:
 *
 *   • `flags` — включены ли тестовые тарифы и брейкер разборов. Прод-гард не
 *     пускает такой процесс, но если его обошли (или флаг включили в рантайме),
 *     это должно быть видно снаружи, а не только в логе старта;
 *   • `checked_at` — когда сервер смотрел на зависимости: без него
 *     мониторинг не отличает свежий ответ от закэшированного;
 *   • `status: degraded` теперь включает вебхук Telegram, а не только БД и
 *     астро-движок. `pre_checkout_query` без вебхука не доставляется — это
 *     «оплата не пройдёт», а не «мелочь».
 *
 * **Коды ответа.** `200` на `degraded` — решение владельца: мониторинг должен
 * прочитать тело и показать, что именно деградировало, а не «HTTP 5xx без
 * подробностей». Исключение — `db: down`: без БД сервис не обслуживает ничего,
 * и там `503` (тело то же, чтобы дежурный видел причину).
 */
@Controller('health')
export class HealthController {
  constructor(
    @Inject(DbService) private readonly db: DbService,
    @Inject(AstroClient) private readonly astro: AstroClient,
    @Inject(APP_ENV) private readonly env: AppEnv,
    @Inject(TelegramWebhookService) private readonly webhook: TelegramWebhookService,
    @Inject(BonusBudgetService) private readonly bonusBudget: BonusBudgetService,
  ) {}

  @Get()
  async health(@Res({ passthrough: true }) response: Response): Promise<HealthResponse> {
    const [dbOk, astroState, push, bonusBudget] = await Promise.all([
      this.db.ping(),
      this.astro.health(),
      this.pushState(),
      // 1.6.14: бюджет бесплатного доступа — видимое снаружи состояние, а не
      // только строка в логе: «подарки кончились» должно объясняться одним
      // запросом к `/health`, а не перепиской.
      this.bonusBudget.state(),
    ]);

    // Состояние вебхука — из последней проверки при старте/диагностике
    // (итерация 26). `stale` значит «не проверяли или проверка старше суток»:
    // это не «всё хорошо» и не «всё плохо», а «не знаем, перезапусти и проверь».
    const webhook = this.webhook.health();

    // `degraded` — если хоть одна зависимость не подтверждена. Сайдкар движка
    // был в формуле с 1.2.0, вебхук добавлен итерацией 36: без него в Telegram
    // не доставляется `pre_checkout_query`.
    // Пуш (итерация 38): если функция включена, а цикл не запускался дольше двух
    // часов — это поломка, которую иначе никто не заметит. Люди просто перестают
    // получать «доброе утро» и не жалуются: отсутствие сообщения не болит.
    // Бюджет бесплатного доступа: исчерпанный бюджет не «поломка», но и не
    // «всё хорошо» — `degraded`, чтобы мониторинг показал это до жалоб
    // («почему код не активируется»).
    const degraded =
      !dbOk || astroState !== 'ok' || webhook.state !== 'ok' || push.stale || bonusBudget.exhausted;

    // `503` только там, где сервис не может обслуживать запросы вообще.
    if (!dbOk) {
      response.status(503);
    }

    return {
      // Сайдкар движка — часть работоспособности: без него не строятся карты.
      status: degraded ? 'degraded' : 'ok',
      version: this.env.APPLICATION_VERSION,
      db: dbOk ? 'ok' : 'down',
      // Клиента LLM с проверкой живости нет: честно `unknown`, а не «ok» по
      // факту наличия ключа в окружении.
      llm: 'unknown',
      astro: astroState,
      telegram_webhook: webhook.state,
      flags: {
        test_plans: this.env.PAYMENTS_TEST_PLANS === '1',
        report_breaker: this.env.REPORT_BREAKER_ENABLED === '1',
        push: {
          enabled: push.enabled,
          last_run_at: push.lastRunAt,
          last_sent_count: push.lastSentCount,
        },
        bonus_budget: {
          spent_rub: bonusBudget.spent_rub,
          limit_rub: bonusBudget.limit_rub,
          exhausted: bonusBudget.exhausted,
        },
      },
      checked_at: new Date().toISOString(),
    };
  }

  /**
   * Состояние утреннего пуша для `/health`.
   *
   * `stale` — включённый пуш не запускался дольше двух часов. Порог выбран по
   * окну: планировщик тикает каждую минуту, цикл пишет строку в `push_runs`
   * каждый запуск, поэтому двух часов молчания достаточно, чтобы отличить
   * «деплой» от «таймер умер».
   */
  private async pushState(): Promise<{
    readonly enabled: boolean;
    readonly lastRunAt: string | null;
    readonly lastSentCount: number;
    readonly stale: boolean;
  }> {
    const enabled = this.env.PUSH_ENABLED === '1';

    if (!enabled) {
      return { enabled: false, lastRunAt: null, lastSentCount: 0, stale: false };
    }

    const row = await this.db.queryOne<{ last_run_at: Date | null; sent: number | null }>(
      `SELECT max(finished_at) AS last_run_at,
              (SELECT sent FROM push_runs ORDER BY started_at DESC LIMIT 1) AS sent
         FROM push_runs`,
    );

    const lastRunAt = row?.last_run_at ?? null;
    const ageMs = lastRunAt === null ? Number.POSITIVE_INFINITY : Date.now() - lastRunAt.getTime();

    return {
      enabled: true,
      lastRunAt: lastRunAt === null ? null : lastRunAt.toISOString(),
      lastSentCount: row?.sent ?? 0,
      stale: ageMs > 2 * 60 * 60 * 1000,
    };
  }
}
