import type {
  InvoiceLinkParams,
  StarSubscriptionCancelResult,
} from '../src/modules/telegram/telegram.client';

export type PushOutcome = 'sent' | 'blocked' | 'rate_limited' | 'failed';

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
  readonly pushes: {
    chatId: number | string;
    text: string;
    button?: { text: string; webAppUrl: string };
    outcome: PushOutcome;
  }[];
  /**
   * Чем отвечать на `sendMessage`-пуш: `blocked` — 403, `rate_limited` — 429.
   * По умолчанию `sent`.
   */
  pushOutcome: PushOutcome;
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
    options?: { button?: { text: string; webAppUrl: string } },
  ): Promise<PushOutcome>;
  createInvoiceLink(params: InvoiceLinkParams): Promise<string>;
  answerPreCheckoutQuery(queryId: string, ok: boolean, errorMessage?: string): Promise<void>;
  sendMessage(chatId: number | string, text: string): Promise<void>;
  sendPhoto(chatId: number | string, photo: string, caption: string): Promise<void>;
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
  const starSubscriptionCancels: FakeTelegram['starSubscriptionCancels'] = [];

  const fake: FakeTelegram = {
    invoiceCalls,
    answers,
    messages,
    refunds,
    pushes,
    photos,
    starSubscriptionCancels,
    pushOutcome: 'sent',
    sendMessageError: null,
    invoiceError: null,
    starCancelOutcome: 'cancelled',
    sendPush(chatId, text, options) {
      const outcome = fake.pushOutcome;
      pushes.push({ chatId, text, outcome, ...(options?.button === undefined ? {} : { button: options.button }) });
      return Promise.resolve(outcome);
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
