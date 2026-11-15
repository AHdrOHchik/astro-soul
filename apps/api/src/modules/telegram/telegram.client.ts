import { Inject, Injectable } from '@nestjs/common';
import { APP_ENV } from '../../config/env.module';
import type { AppEnv } from '../../config/env';
import { ApiError } from '../../common/api-error';
import { JsonLogger } from '../../common/logger';

/** Таймаут Bot API: платёжные методы не должны висеть дольше. */
export const TELEGRAM_TIMEOUT_MS = 8000;
/**
 * Отмена автопродления при удалении данных: 5 секунд, потому что человек уже
 * нажал «удалить навсегда» и ждёт ответа. Не успели — удаляем без Telegram,
 * повтор пойдёт из ночного джоба (задача A, п. 2 задания).
 */
export const TELEGRAM_CANCEL_TIMEOUT_MS = 5000;
export const TELEGRAM_API_BASE = 'https://api.telegram.org';

/**
 * Результат `editUserStarSubscription`. Метод не бросает: его вызывают ради
 * побочного эффекта в Telegram, а решение об удалении данных от него не зависит.
 *
 *   ok: false, code: 'timeout'      — не ответил за 5 секунд / сеть;
 *   ok: false, code: 'telegram_error' — ответил `ok:false` (в `description` — текст);
 *   ok: false, code: 'no_charge_id'  — нет пары (telegram_id, charge_id), звать некого.
 */
export type StarSubscriptionCancelResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly code: 'timeout' | 'telegram_error' | 'no_charge_id';
      readonly description: string | null;
    };

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

/**
 * Хвост `charge_id` для логов: 6 символов хватает, чтобы найти платёж, а
 * полный идентификатор в тексте лога не нужен (ПДн-гигиена, задача D).
 */
function tail(chargeId: string): string {
  return chargeId.slice(-6);
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

    // Молчаливый уход в api.telegram.org на стенде уже стоил одного невалидного
    // прогона приёмки: `POST /billing/invoice` отвечал 502 и не создавал ни
    // одного инвойса. В непроизводственном окружении об этом пишем в лог.
    if (env.TELEGRAM_API_BASE_URL === undefined && env.NODE_ENV !== 'production') {
      this.logger.warn('telegram_api_base_default', { url: this.baseUrl, env: env.NODE_ENV });
    }
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

  /**
   * Пуш с разбором результата — в отличие от `sendMessage`, который глотает
   * ошибки ради платежа. Здесь важно знать причину:
   *   `blocked` — 403 (бот заблокирован): карту больше не пушим;
   *   `rate_limited` — 429: в этом прогоне не ретраим;
   *   `failed` — всё остальное (сеть, 5xx, 400).
   */
  async sendPush(
    chatId: number | string,
    text: string,
    options: { readonly button?: { readonly text: string; readonly webAppUrl: string } } = {},
  ): Promise<'sent' | 'blocked' | 'rate_limited' | 'failed'> {
    const body: Record<string, unknown> = {
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    };

    if (options.button !== undefined) {
      body['reply_markup'] = {
        inline_keyboard: [[{ text: options.button.text, web_app: { url: options.button.webAppUrl } }]],
      };
    }

    const response = await this.post('sendMessage', body);

    if (response.status === 403) {
      this.logger.warn('telegram_push_blocked', { reason: 'blocked' });
      return 'blocked';
    }

    if (response.status === 429) {
      this.logger.warn('telegram_push_rate_limited', { reason: 'rate_limited' });
      return 'rate_limited';
    }

    if (!response.ok) {
      this.logger.warn('telegram_push_failed', { status: response.status });
      return 'failed';
    }

    return 'sent';
  }

  /** Возврат звёзд: доступен, пока платёж не выведен (payments.md §3.5). */
  async refundStarPayment(telegramUserId: number, chargeId: string): Promise<boolean> {
    const result = await this.call<boolean>('refundStarPayment', {
      user_id: telegramUserId,
      telegram_payment_charge_id: chargeId,
    });
    return result === true;
  }

  /**
   * Отключить автопродление звёздной подписки: `editUserStarSubscription`.
   *
   * Telegram — отдельная сущность: локальная строка `subscriptions` про
   * автопродление ничего не знает, и без этого вызова звёзды спишут за
   * следующий период уже после `DELETE /me`.
   *
   * Никогда не бросает. Причина не в «мягкости»: удаление ПДн по 152-ФЗ не
   * может зависеть от доступности чужого API. Результат пишется в
   * `subscriptions.telegram_cancel_state`, неуспех повторяет ночной джоб.
   *
   * `chargeId` — `telegram_payment_charge_id` последнего успешного
   * `successful_payment` подписки (а не первый за всё время): по чужому или
   * просроченному charge_id Telegram отвечает `CHARGE_ID_INVALID`.
   */
  async editUserStarSubscription(
    telegramUserId: number | null,
    chargeId: string | null,
  ): Promise<StarSubscriptionCancelResult> {
    if (telegramUserId === null || chargeId === null || chargeId === '') {
      return { ok: false, code: 'no_charge_id', description: null };
    }

    let response: { status: number; ok: boolean; description?: string };
    try {
      response = await this.post(
        'editUserStarSubscription',
        {
          user_id: telegramUserId,
          telegram_payment_charge_id: chargeId,
          is_canceled: true,
        },
        TELEGRAM_CANCEL_TIMEOUT_MS,
      );
    } catch (error) {
      // В лог — только хвост charge_id: он уникален и по нему видно платёж,
      // но полный идентификатор в тексте лога не нужен (задача D).
      this.logger.warn('telegram_cancel_unreachable', {
        reason: error instanceof ApiError ? error.code : 'unknown',
        charge_tail: tail(chargeId),
      });
      return { ok: false, code: 'timeout', description: null };
    }

    if (!response.ok) {
      this.logger.warn('telegram_cancel_failed', {
        status: response.status,
        description: response.description ?? null,
        charge_tail: tail(chargeId),
      });
      return {
        ok: false,
        code: 'telegram_error',
        description: response.description ?? null,
      };
    }

    return { ok: true };
  }

  /** Сырой ответ Bot API: нужен `sendPush`, где важен HTTP-статус. */
  private async post(
    method: string,
    body: Record<string, unknown>,
    timeoutMs: number = TELEGRAM_TIMEOUT_MS,
  ): Promise<{ status: number; ok: boolean; result?: unknown; description?: string }> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/bot${this.token}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      this.logger.error('telegram_unreachable', {
        method,
        reason: error instanceof Error ? error.name : 'unknown',
      });
      throw upstreamError('telegram_unreachable');
    }

    const payload = (await response.json().catch(() => null)) as
      | { ok?: boolean; result?: unknown; description?: string }
      | null;

    return {
      status: response.status,
      ok: response.ok && payload?.ok === true,
      ...(payload?.result === undefined ? {} : { result: payload.result }),
      ...(payload?.description === undefined ? {} : { description: payload.description }),
    };
  }

  private async call<T = unknown>(method: string, body: Record<string, unknown>): Promise<T> {
    const response = await this.post(method, body);

    if (!response.ok) {
      this.logger.error('telegram_method_failed', {
        method,
        status: response.status,
        // description от Bot API безопасен для логов: без payload и ПДн
        description: response.description ?? null,
      });
      throw upstreamError('telegram_method_failed');
    }

    return response.result as T;
  }
}
