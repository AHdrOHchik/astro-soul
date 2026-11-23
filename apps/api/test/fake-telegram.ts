import type {
  BotApiAnswer,
  InlineQueryPhotoResult,
  InvoiceLinkParams,
  PushButton,
  PushSendResult,
  PushSendStatus,
  StarSubscriptionCancelResult,
} from '../src/modules/telegram/telegram.client';

/** Статус, которым «Bot API» отвечает на пуш: старые имена сохранены. */
export type PushOutcome = PushSendStatus | 'rate_limited';

/**
 * Подмена Bot API: тесты не ходят в сеть и не тратят звёзды.
 * Записывает вызовы, чтобы проверять поведение обработчика платежей.
 */
export interface FakeTelegram {
  readonly invoiceCalls: InvoiceLinkParams[];
  readonly answers: { queryId: string; ok: boolean; errorMessage?: string }[];
  readonly messages: { chatId: number | string; text: string }[];
  readonly refunds: { userId: number; chargeId: string }[];
  /** Вызовы `editUserStarSubscription`: проверяем пару (user_id, charge_id). */
  readonly starSubscriptionCancels: {
    userId: number | null;
    chargeId: string | null;
  }[];
  /** Пуши удержания: что отправили и чем ответил «Bot API». */
  /** Картинки, отправленные ботом: карточки шеринга по `/start sh_<short_id>`. */
  readonly photos: { chatId: number | string; photo: string; caption: string }[];
  /** Ответы на `inline_query` (1.6.9): что бот предложил в чат. */
  readonly inlineAnswers: { queryId: string; results: readonly InlineQueryPhotoResult[] }[];
  /** Включён ли inline-режим у «бота»: `getMe().supports_inline_queries`. */
  inlineMode: boolean;
  /** `true` — «Bot API недоступен», `getMe` вернёт `ok: false`. */
  getMeError: boolean;
  readonly pushes: {
    chatId: number | string;
    text: string;
    /** Ряды кнопок как их увидит Telegram: `web_app` и `callback_data` (1.6.13). */
    buttons?: readonly (readonly PushButton[])[];
    outcome: PushOutcome;
  }[];
  /** Ответы на нажатия кнопок: `answerCallbackQuery` (кнопка «Отключить»). */
  readonly callbackAnswers: { id: string; text: string }[];
  /**
   * Чем отвечать на `sendMessage`-пуш: `blocked` — 403, `rate_limited` — 429.
   * По умолчанию `sent`.
   */
  pushOutcome: PushOutcome;
  /** `429`: сколько секунд просит подождать Bot API (`parameters.retry_after`). */
  pushRetryAfter: number | null;
  /**
   * Очередь статусов на ближайшие отправки: `['rate_limited', 'sent']` —
   * первый вызов получит `429`, второй пройдёт. Пусто — действует `pushOutcome`.
   */
  pushQueue: PushOutcome[];
  /**
   * Чем отвечает «Bot API» на `sendMessage`: `null` — успешно (по умолчанию).
   * Итерация 25: сбой сообщения после выдачи доступа не должен отменять платёж.
   */
  sendMessageError: Error | null;
  /**
   * Чем отвечает `createInvoiceLink`: `null` — ссылкой (по умолчанию),
   * иначе — этим исключением (например, отказ по периоду подписки).
   */
  invoiceError: Error | null;
  /**
   * Чем отвечает Telegram на отмену автопродления:
   *   `cancelled` — `{ok:true, result:true}` (по умолчанию);
   *   `failed`    — `{ok:false}` = 400 CHARGE_ID_INVALID;
   *   `timeout`   — сеть/таймаут;
   *   `throws`    — исключение до ответа: проверяем, что удаление всё равно идёт.
   */
  starCancelOutcome: 'cancelled' | 'failed' | 'timeout' | 'throws';
  sendPush(
    chatId: number | string,
    text: string,
    options?: { buttons?: readonly (readonly PushButton[])[] },
  ): Promise<PushSendResult>;
  createInvoiceLink(params: InvoiceLinkParams): Promise<string>;
  answerPreCheckoutQuery(queryId: string, ok: boolean, errorMessage?: string): Promise<void>;
  sendMessage(chatId: number | string, text: string): Promise<void>;
  answerCallbackQuery(callbackQueryId: string, text: string): Promise<void>;
  sendPhoto(chatId: number | string, photo: string, caption: string): Promise<void>;
  answerInlineQuery(
    inlineQueryId: string,
    results: readonly InlineQueryPhotoResult[],
  ): Promise<void>;
  getMe(): Promise<BotApiAnswer<{ id: number; username?: string; supports_inline_queries?: boolean }>>;
  refundStarPayment(userId: number, chargeId: string): Promise<boolean>;
  editUserStarSubscription(
    userId: number | null,
    chargeId: string | null,
  ): Promise<StarSubscriptionCancelResult>;
}

export function makeFakeTelegram(): FakeTelegram {
  const invoiceCalls: InvoiceLinkParams[] = [];
  const answers: { queryId: string; ok: boolean; errorMessage?: string }[] = [];
  const messages: { chatId: number | string; text: string }[] = [];
  const refunds: { userId: number; chargeId: string }[] = [];
  const pushes: FakeTelegram['pushes'] = [];
  const photos: FakeTelegram['photos'] = [];
  const inlineAnswers: FakeTelegram['inlineAnswers'] = [];
  const starSubscriptionCancels: FakeTelegram['starSubscriptionCancels'] = [];
  const callbackAnswers: FakeTelegram['callbackAnswers'] = [];

  const fake: FakeTelegram = {
    invoiceCalls,
    answers,
    messages,
    refunds,
    pushes,
    photos,
    inlineAnswers,
    starSubscriptionCancels,
    callbackAnswers,
    inlineMode: true,
    getMeError: false,
    pushOutcome: 'sent',
    pushRetryAfter: 1,
    pushQueue: [],
    sendMessageError: null,
    invoiceError: null,
    starCancelOutcome: 'cancelled',
    sendPush(chatId, text, options) {
      const outcome = fake.pushQueue.length > 0 ? (fake.pushQueue.shift() ?? 'sent') : fake.pushOutcome;
      pushes.push({
        chatId,
        text,
        outcome,
        ...(options?.buttons === undefined ? {} : { buttons: options.buttons }),
      });

      if (outcome === 'sent') {
        return Promise.resolve({ status: 'sent', retryAfterSeconds: null, error: null });
      }

      if (outcome === 'rate_limited') {
        return Promise.resolve({
          status: 'rate_limited',
          retryAfterSeconds: fake.pushRetryAfter,
          error: 'rate_limited',
        });
      }

      return Promise.resolve({
        status: outcome,
        retryAfterSeconds: null,
        error: outcome === 'blocked' ? 'blocked' : 'telegram_500',
      });
    },
    answerCallbackQuery(callbackQueryId, text) {
      callbackAnswers.push({ id: callbackQueryId, text });
      return Promise.resolve();
    },
    createInvoiceLink(params) {
      invoiceCalls.push(params);

      if (fake.invoiceError !== null) {
        return Promise.reject(fake.invoiceError);
      }

      return Promise.resolve(`https://t.me/$invoice-${invoiceCalls.length}`);
    },
    answerPreCheckoutQuery(queryId, ok, errorMessage) {
      answers.push({ queryId, ok, ...(errorMessage === undefined ? {} : { errorMessage }) });
      return Promise.resolve();
    },
    sendMessage(chatId, text) {
      messages.push({ chatId, text });

      if (fake.sendMessageError !== null) {
        return Promise.reject(fake.sendMessageError);
      }

      return Promise.resolve();
    },
    sendPhoto(chatId, photo, caption) {
      photos.push({ chatId, photo, caption });
      return Promise.resolve();
    },
    answerInlineQuery(inlineQueryId, results) {
      inlineAnswers.push({ queryId: inlineQueryId, results });
      return Promise.resolve();
    },
    getMe() {
      if (fake.getMeError) {
        return Promise.resolve({
          reachable: false,
          ok: false,
          status: 0,
          result: null,
          description: 'unreachable',
        });
      }

      return Promise.resolve({
        reachable: true,
        ok: true,
        status: 200,
        result: { id: 1, username: 'astro_soul_bot', supports_inline_queries: fake.inlineMode },
        description: null,
      });
    },
    refundStarPayment(userId, chargeId) {
      refunds.push({ userId, chargeId });
      return Promise.resolve(true);
    },
    editUserStarSubscription(userId, chargeId) {
      starSubscriptionCancels.push({ userId, chargeId });

      if (userId === null || chargeId === null || chargeId === '') {
        return Promise.resolve({ ok: false, code: 'no_charge_id', description: null });
      }

      switch (fake.starCancelOutcome) {
        case 'failed':
          return Promise.resolve({
            ok: false,
            code: 'telegram_error',
            description: 'Bad Request: CHARGE_ID_INVALID',
          });
        case 'timeout':
          return Promise.resolve({ ok: false, code: 'timeout', description: null });
        case 'throws':
          return Promise.reject(new Error('telegram: соединение закрыто'));
        default:
          return Promise.resolve({ ok: true });
      }
    },
  };

  return fake;
}
