import { Controller, Get, Inject, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { HealthResponse } from '@astro-soul/shared';
import { DbService } from '../../db/db.service';
import { APP_ENV } from '../../config/env.module';
import type { AppEnv } from '../../config/env';
import { AstroClient } from '../astro/astro.client';
import { TelegramWebhookService } from '../telegram/telegram-webhook.service';

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
  ) {}

  @Get()
  async health(@Res({ passthrough: true }) response: Response): Promise<HealthResponse> {
    const [dbOk, astroState] = await Promise.all([this.db.ping(), this.astro.health()]);

    // Состояние вебхука — из последней проверки при старте/диагностике
    // (итерация 26). `stale` значит «не проверяли или проверка старше суток»:
    // это не «всё хорошо» и не «всё плохо», а «не знаем, перезапусти и проверь».
    const webhook = this.webhook.health();

    // `degraded` — если хоть одна зависимость не подтверждена. Сайдкар движка
    // был в формуле с 1.2.0, вебхук добавлен итерацией 36: без него в Telegram
    // не доставляется `pre_checkout_query`.
    const degraded = !dbOk || astroState !== 'ok' || webhook.state !== 'ok';

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
      },
      checked_at: new Date().toISOString(),
    };
  }
}
