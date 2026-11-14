import type { InvoiceLinkParams } from '../src/modules/telegram/telegram.client';

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
  /** Пуши удержания: что отправили и чем ответил «Bot API». */
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
  sendPush(
    chatId: number | string,
    text: string,
    options?: { button?: { text: string; webAppUrl: string } },
  ): Promise<PushOutcome>;
  createInvoiceLink(params: InvoiceLinkParams): Promise<string>;
  answerPreCheckoutQuery(queryId: string, ok: boolean, errorMessage?: string): Promise<void>;
  sendMessage(chatId: number | string, text: string): Promise<void>;
  refundStarPayment(userId: number, chargeId: string): Promise<boolean>;
}

export function makeFakeTelegram(): FakeTelegram {
  const invoiceCalls: InvoiceLinkParams[] = [];
  const answers: { queryId: string; ok: boolean; errorMessage?: string }[] = [];
  const messages: { chatId: number | string; text: string }[] = [];
  const refunds: { userId: number; chargeId: string }[] = [];
  const pushes: FakeTelegram['pushes'] = [];

  const fake: FakeTelegram = {
    invoiceCalls,
    answers,
    messages,
    refunds,
    pushes,
    pushOutcome: 'sent',
    sendPush(chatId, text, options) {
      const outcome = fake.pushOutcome;
      pushes.push({ chatId, text, outcome, ...(options?.button === undefined ? {} : { button: options.button }) });
      return Promise.resolve(outcome);
    },
    createInvoiceLink(params) {
      invoiceCalls.push(params);
      return Promise.resolve(`https://t.me/$invoice-${invoiceCalls.length}`);
    },
    answerPreCheckoutQuery(queryId, ok, errorMessage) {
      answers.push({ queryId, ok, ...(errorMessage === undefined ? {} : { errorMessage }) });
      return Promise.resolve();
    },
    sendMessage(chatId, text) {
      messages.push({ chatId, text });
      return Promise.resolve();
    },
    refundStarPayment(userId, chargeId) {
      refunds.push({ userId, chargeId });
      return Promise.resolve(true);
    },
  };

  return fake;
}
