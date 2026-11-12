import { Body, Controller, Headers, HttpCode, Inject, Param, Post } from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import { APP_ENV } from '../../config/env.module';
import type { AppEnv } from '../../config/env';
import { forbidden } from '../../common/api-error';
import { JsonLogger } from '../../common/logger';
import { PaymentsService } from './payments.service';
import { TelegramStartService } from '../telegram/telegram-start.service';

const SECRET_HEADER = 'x-telegram-bot-api-secret-token';

/** Достаём сообщение с текстом `/start …`; всё остальное — не наше дело. */
function readStartMessage(update: unknown): { chat: { id: number }; text?: string } | null {
  if (typeof update !== 'object' || update === null) {
    return null;
  }

  const message = (update as { message?: unknown }).message;
  if (typeof message !== 'object' || message === null) {
    return null;
  }

  const { chat, text } = message as { chat?: { id?: unknown }; text?: unknown };
  if (typeof chat?.id !== 'number' || typeof text !== 'string') {
    return null;
  }

  return { chat: { id: chat.id }, text };
}

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
    @Inject(TelegramStartService) private readonly start: TelegramStartService,
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

    // `/start chart_<id>` — ссылка шаринга ведёт на карту, а не в пустой
    // онбординг (контракт 1.4.0). Ошибка ответа боту не должна ронять вебхук:
    // Telegram повторит доставку, а платёж уже записан.
    const message = readStartMessage(update);
    if (message !== null) {
      try {
        await this.start.handleMessage(message);
      } catch (error) {
        this.logger.warn('telegram_start_failed', {
          reason: error instanceof Error ? error.name : 'unknown',
        });
      }
    }

    return { ok: true };
  }
}
