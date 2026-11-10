import { Body, Controller, Headers, HttpCode, Inject, Param, Post } from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import { APP_ENV } from '../../config/env.module';
import type { AppEnv } from '../../config/env';
import { forbidden } from '../../common/api-error';
import { JsonLogger } from '../../common/logger';
import { PaymentsService } from './payments.service';

const SECRET_HEADER = 'x-telegram-bot-api-secret-token';

function safeEqual(expected: string, provided: string | undefined): boolean {
  if (provided === undefined) {
    return false;
  }
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(provided, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Вебхук Telegram Bot API (контракт: `security: []`, своя защита).
 *
 * Двойная проверка: секрет в пути (`setWebhook` url) и заголовок
 * `X-Telegram-Bot-Api-Secret-Token`. Без настроенного секрета — закрыто всегда.
 *
 * Ответ 200 отдаётся после обработки: при падении БД Telegram повторит доставку,
 * а обработчик идемпотентен по `telegram_payment_charge_id`.
 */
@Controller('internal/telegram')
export class TelegramWebhookController {
  constructor(
    @Inject(PaymentsService) private readonly payments: PaymentsService,
    @Inject(APP_ENV) private readonly env: AppEnv,
    @Inject(JsonLogger) private readonly logger: JsonLogger,
  ) {}

  @Post('webhook/:secret')
  @HttpCode(200)
  async handle(
    @Param('secret') secret: string,
    @Headers(SECRET_HEADER) headerSecret: string | undefined,
    @Body() update: unknown,
  ): Promise<{ ok: true }> {
    const expected = this.env.TELEGRAM_WEBHOOK_SECRET;

    if (expected === undefined || !safeEqual(expected, secret) || !safeEqual(expected, headerSecret)) {
      this.logger.warn('webhook_forbidden', { reason: 'secret_mismatch' });
      throw forbidden({ reason: 'webhook_secret' });
    }

    await this.payments.handleUpdate(update);
    return { ok: true };
  }
}
