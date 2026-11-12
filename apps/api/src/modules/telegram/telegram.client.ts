import { Inject, Injectable } from '@nestjs/common';
import { APP_ENV } from '../../config/env.module';
import type { AppEnv } from '../../config/env';
import { ApiError } from '../../common/api-error';
import { JsonLogger } from '../../common/logger';

/** Таймаут Bot API: платёжные методы не должны висеть дольше. */
export const TELEGRAM_TIMEOUT_MS = 8000;
export const TELEGRAM_API_BASE = 'https://api.telegram.org';

export interface InvoiceLinkParams {
  readonly title: string;
  readonly description: string;
  /** ≤ 128 байт (payments.md §2). Проверяется до вызова. */
  readonly payload: string;
  readonly prices: readonly { readonly label: string; readonly amount: number }[];
  /** Только для подписок: период в секундах. */
  readonly subscriptionPeriod?: number;
}

export interface TelegramUserRef {
  readonly id: number;
}

/** Ошибка вывода денег/инвойсов: наружу — INTERNAL, детали только в логах. */
function upstreamError(reason: string): ApiError {
  return new ApiError('INTERNAL', 502, { reason, logFields: { reason } });
}

/**
 * Тонкая обёртка над Bot API. Только методы, которые нужны продукту:
 * инвойсы, ответ на pre_checkout_query, сообщения, возвраты (payments.md §2–3.5).
 * Ничего не логируем из тела: там бывают ссылки с payload.
 */
@Injectable()
export class TelegramClient {
  private readonly token: string;
  private readonly baseUrl: string;

  constructor(
    @Inject(APP_ENV) env: AppEnv,
    @Inject(JsonLogger) private readonly logger: JsonLogger,
  ) {
    this.token = env.TELEGRAM_BOT_TOKEN;
    this.baseUrl = env.TELEGRAM_API_BASE_URL ?? TELEGRAM_API_BASE;
  }

  async createInvoiceLink(params: InvoiceLinkParams): Promise<string> {
    const body: Record<string, unknown> = {
      title: params.title,
      description: params.description,
      payload: params.payload,
      currency: 'XTR',
      prices: params.prices.map((price) => ({ label: price.label, amount: price.amount })),
    };
    if (params.subscriptionPeriod !== undefined) {
      body['subscription_period'] = params.subscriptionPeriod;
    }

    const result = await this.call<string>('createInvoiceLink', body);
    return result;
  }

  async answerPreCheckoutQuery(queryId: string, ok: boolean, errorMessage?: string): Promise<void> {
    await this.call('answerPreCheckoutQuery', {
      pre_checkout_query_id: queryId,
      ok,
      ...(errorMessage === undefined ? {} : { error_message: errorMessage }),
    });
  }

  async sendMessage(
    chatId: number | string,
    text: string,
    options: { readonly button?: { readonly text: string; readonly webAppUrl: string } } = {},
  ): Promise<void> {
    // Кнопка открывает мини-апп сразу на нужной карте (`startapp=chart_<id>`),
    // а не пустой онбординг (контракт 1.4.0, `x-bot.share_link_template`).
    const replyMarkup =
      options.button === undefined
        ? {}
        : {
            reply_markup: {
              inline_keyboard: [[{ text: options.button.text, web_app: { url: options.button.webAppUrl } }]],
            },
          };

    try {
      await this.call('sendMessage', {
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        ...replyMarkup,
      });
    } catch (error) {
      // Сообщение — не критичная часть платежа: платёж уже записан.
      this.logger.warn('telegram_send_message_failed', {
        reason: error instanceof ApiError ? error.code : 'unknown',
      });
    }
  }

  /** Возврат звёзд: доступен, пока платёж не выведен (payments.md §3.5). */
  async refundStarPayment(telegramUserId: number, chargeId: string): Promise<boolean> {
    const result = await this.call<boolean>('refundStarPayment', {
      user_id: telegramUserId,
      telegram_payment_charge_id: chargeId,
    });
    return result === true;
  }

  private async call<T = unknown>(method: string, body: Record<string, unknown>): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/bot${this.token}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TELEGRAM_TIMEOUT_MS),
      });
    } catch (error) {
      this.logger.error('telegram_unreachable', {
        method,
        reason: error instanceof Error ? error.name : 'unknown',
      });
      throw upstreamError('telegram_unreachable');
    }

    const payload = (await response.json().catch(() => null)) as
      | { ok?: boolean; result?: T; description?: string }
      | null;

    if (!response.ok || payload?.ok !== true) {
      this.logger.error('telegram_method_failed', {
        method,
        status: response.status,
        // description от Bot API безопасен для логов: без payload и ПДн
        description: payload?.description ?? null,
      });
      throw upstreamError('telegram_method_failed');
    }

    return payload.result as T;
  }
}
