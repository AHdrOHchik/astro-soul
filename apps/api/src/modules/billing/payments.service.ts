import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { PlanCode } from '@astro-soul/shared';
import { DbService } from '../../db/db.service';
import { DeadlineError, withDeadline } from '../../common/deadline';
import { JsonLogger } from '../../common/logger';
import { TelegramClient } from '../telegram/telegram.client';
import { EventsRepository } from '../events/events.repository';
import { BillingRepository, type RejectReason } from './billing.repository';
import { parseInvoicePayload, type InvoicePayload } from './billing.dto';
import { PlansRepository, type PlanRow } from './plans.repository';

export interface TelegramSuccessfulPayment {
  readonly currency: string;
  readonly total_amount: number;
  readonly invoice_payload: string;
  readonly telegram_payment_charge_id: string;
  readonly provider_payment_charge_id?: string;
  readonly subscription_expiration_date?: number;
}

export interface TelegramPreCheckoutQuery {
  readonly id: string;
  readonly from: { readonly id: number };
  readonly currency: string;
  readonly total_amount: number;
  readonly invoice_payload: string;
}

export interface TelegramUpdate {
  readonly update_id?: number;
  readonly pre_checkout_query?: TelegramPreCheckoutQuery;
  readonly message?: {
    readonly chat: { readonly id: number };
    readonly from?: { readonly id: number };
    readonly successful_payment?: TelegramSuccessfulPayment;
  };
}

/**
 * Причины отказа из контракта (`payment_rejected.props.code`).
 * `invoice_invalidated` и `user_deleted` — QA-15: оплата после удаления данных;
 * `refund_failed` — отказ записан, но звёзды вернуть не удалось.
 */
export type RejectCode = RejectReason | 'refund_failed';

/**
 * Что стало с платежом: доступ выдан, отказ по деньгам, повтор доставки или
 * «деньги записаны, доступ пока нет» — такой платёж доводит джоб
 * `pending_payments_resolve` (`paid`, `processed = false`).
 */
type PaymentOutcome =
  | { readonly kind: 'processed'; readonly plan: PlanRow; readonly expiresAt: Date | null; readonly renewed: boolean }
  | { readonly kind: 'rejected'; readonly code: RejectCode }
  | { readonly kind: 'duplicate' }
  | { readonly kind: 'deferred' };

type ProcessOutcome =
  | { readonly kind: 'duplicate' }
  | {
      readonly kind: 'processed';
      readonly plan: PlanRow;
      readonly expiresAt: Date | null;
      readonly renewed: boolean;
    };

/**
 * Бюджет `pre_checkout_query`. Telegram ждёт ответ 10 секунд и после этого
 * показывает «ошибка оплаты»; человек в этот момент смотрит на лоадер.
 *
 *   • цель — 1 с: больше не нужно, все проверки — три чтения по индексам;
 *   • жёсткий срок — 8 с: остаётся 2 с на сам ответ `answerPreCheckoutQuery`;
 *   • таймаут чтения из БД — 2 с: зависшая строка не съедает весь бюджет.
 *
 * Замер `duration_ms` пишется в лог каждого ответа (`pre_checkout_answered`),
 * поэтому «стало медленно» видно до того, как превратится в отказы.
 */
export const PRECHECKOUT_TARGET_MS = 1_000;
export const PRECHECKOUT_DEADLINE_MS = 8_000;
export const PRECHECKOUT_DB_TIMEOUT_MS = 2_000;

/** Тексты отказов: человек читает их в окне оплаты. */
const PRECHECKOUT_TEXT = {
  unavailable: 'Товар недоступен, попробуй ещё раз',
  restart: 'Оплата больше недоступна — начни заново',
  amount: 'Сумма не совпадает со счётом — начни заново',
  retry: 'Оплата не подтвердилась — попробуй ещё раз',
} as const;

/**
 * Решение по `pre_checkout_query`: что ответить и что об этом записать.
 *
 * `reason` — машинный код для логов, событий и метрик (`payments.md` §3.1):
 * по нему видно, почему человек увидел «ошибка оплаты», без чтения его данных.
 */
interface PreCheckoutDecision {
  readonly ok: boolean;
  readonly reason: string;
  readonly text?: string;
  readonly plan: PlanCode | null;
  readonly amount: number | null;
  readonly expected: number | null;
}

function formatDate(date: Date): string {
  // Дата в UTC: часовой пояс пользователя в платеже не передаётся,
  // а показывать «сдвинутую» дату окончания хуже, чем округлённую.
  return date.toLocaleDateString('ru-RU', { timeZone: 'UTC' });
}

/**
 * Обработка апдейтов Telegram по деньгам.
 *
 * Доставка «at least once» (payments.md §3.2): учёт платежа и выдача доступа
 * идут одной транзакцией с блокировкой по `telegram_payment_charge_id`,
 * поэтому повторная доставка не создаёт второй доступ.
 */
@Injectable()
export class PaymentsService {
  constructor(
    @Inject(BillingRepository) private readonly repo: BillingRepository,
    @Inject(PlansRepository) private readonly plans: PlansRepository,
    @Inject(DbService) private readonly db: DbService,
    @Inject(TelegramClient) private readonly telegram: TelegramClient,
    @Inject(EventsRepository) private readonly events: EventsRepository,
    @Inject(JsonLogger) private readonly logger: JsonLogger,
  ) {}

  /**
   * Единая точка входа вебхука. Неизвестные апдейты молча игнорируются.
   *
   * `pre_checkout_query` не бросает никогда: ответ уходит всегда, даже если
   * обработка упала (`payments.md` §3.1). `successful_payment` бросать может —
   * тогда вебхук отвечает `500`, а Telegram повторяет доставку, потому что
   * потерять платёж хуже, чем обработать его дважды (идемпотентность по
   * `telegram_payment_charge_id`).
   */
  async handleUpdate(update: unknown): Promise<void> {
    if (typeof update !== 'object' || update === null) {
      return;
    }

    const payload = update as TelegramUpdate;

    if (payload.pre_checkout_query !== undefined) {
      await this.handlePreCheckout(payload.pre_checkout_query);
      return;
    }

    const payment = payload.message?.successful_payment;
    if (payment !== undefined) {
      await this.handleSuccessfulPayment(
        payload.message?.chat.id ?? null,
        payload.message?.from?.id ?? null,
        payment,
      );
    }
  }

  /**
   * `pre_checkout_query`: ответ обязателен **всегда**.
   *
   * Дефект, который здесь закрывается (итерация 25): обработчик бежал без
   * try/catch и без срока, поэтому любое исключение (или медленная база) —
   * это молчание в ответ на запрос Telegram, человек видит «ошибка оплаты»
   * после лоадера, а в логах нет ни строки о том, что запрос вообще был.
   *
   * Теперь: срок, отказ с человеческим текстом при любой ошибке, событие с
   * `reason` и `duration_ms` на каждый запрос.
   */
  private async handlePreCheckout(query: TelegramPreCheckoutQuery): Promise<void> {
    const startedAt = Date.now();
    const payload = parseInvoicePayload(query.invoice_payload);
    const plan = payload === null ? null : payload.p;

    let decision: PreCheckoutDecision;

    try {
      decision = await withDeadline(
        this.verifyPreCheckout(query, payload),
        PRECHECKOUT_DEADLINE_MS,
      );
    } catch (error) {
      const timedOut = error instanceof DeadlineError;

      // Срок или падение — это не «неверный счёт», и путать их в логе нельзя:
      // по `pre_checkout_timeout` чинят базу, по `handler_error` — код.
      this.logger.error(timedOut ? 'pre_checkout_timeout' : 'pre_checkout_handler_failed', {
        plan,
        amount: query.total_amount,
        deadline_ms: timedOut ? PRECHECKOUT_DEADLINE_MS : null,
        reason: error instanceof Error ? error.name : 'unknown',
      });

      decision = {
        ok: false,
        reason: timedOut ? 'timeout' : 'handler_error',
        text: PRECHECKOUT_TEXT.retry,
        plan,
        amount: query.total_amount,
        expected: null,
      };
    }

    const answered = await this.answerSafely(query.id, decision);
    const durationMs = Date.now() - startedAt;

    this.logger.info('pre_checkout_answered', {
      ok: decision.ok,
      reason: decision.reason,
      plan: decision.plan,
      amount: decision.amount,
      expected: decision.expected,
      duration_ms: durationMs,
      answered,
    });

    if (!decision.ok) {
      this.logger.warn('pre_checkout_rejected', {
        reason: decision.reason,
        plan: decision.plan,
        amount: decision.amount,
        expected: decision.expected,
        duration_ms: durationMs,
      });
    }

    if (durationMs > PRECHECKOUT_TARGET_MS) {
      this.logger.warn('pre_checkout_slow', { duration_ms: durationMs, reason: decision.reason });
    }

    // Метрики «сколько оплат упало за сутки» считаются по `events`
    // (`/admin/metrics`, задача 4). Пишем после ответа Telegram: если запись
    // события не удалась, ответ всё равно уже ушёл.
    await this.logPreCheckoutEvents(decision, payload, query);
  }

  /**
   * Проверки `pre_checkout_query` — только чтения по индексам, с таймаутом на
   * каждое (2 с). Никаких обращений к LLM, Telegram и тяжёлых агрегатов.
   */
  private async verifyPreCheckout(
    query: TelegramPreCheckoutQuery,
    payload: InvoicePayload | null,
  ): Promise<PreCheckoutDecision> {
    if (payload === null) {
      return {
        ok: false,
        reason: 'payload_invalid',
        text: PRECHECKOUT_TEXT.unavailable,
        plan: null,
        amount: query.total_amount,
        expected: null,
      };
    }

    if (query.currency !== 'XTR') {
      return {
        ok: false,
        reason: 'currency',
        text: PRECHECKOUT_TEXT.unavailable,
        plan: payload.p,
        amount: query.total_amount,
        expected: null,
      };
    }

    const plan = await this.plans.getPlan(payload.p, PRECHECKOUT_DB_TIMEOUT_MS);
    if (plan === null) {
      return {
        ok: false,
        reason: 'plan_unknown',
        text: PRECHECKOUT_TEXT.unavailable,
        plan: payload.p,
        amount: query.total_amount,
        expected: null,
      };
    }

    const invoice = await this.repo.findInvoiceByIdeaKey(
      payload.u,
      payload.k,
      PRECHECKOUT_DB_TIMEOUT_MS,
    );

    if (invoice === null) {
      return {
        ok: false,
        reason: 'invoice_missing',
        text: PRECHECKOUT_TEXT.restart,
        plan: payload.p,
        amount: query.total_amount,
        expected: null,
      };
    }

    // QA-15: счёт аннулирован вместе с удалением данных. Отдельный `reason`:
    // в метриках это «человек платит по счёту, которого больше нет», а не
    // «сумма не сошлась».
    if (invoice.status === 'invalidated') {
      return {
        ok: false,
        reason: 'invoice_invalidated_price_changed',
        text: PRECHECKOUT_TEXT.restart,
        plan: payload.p,
        amount: query.total_amount,
        expected: invoice.stars,
      };
    }

    if (invoice.status !== 'created') {
      return {
        ok: false,
        reason: 'invoice_not_payable',
        text: PRECHECKOUT_TEXT.restart,
        plan: payload.p,
        amount: query.total_amount,
        expected: invoice.stars,
      };
    }

    if (!(await this.repo.userExists(payload.u, PRECHECKOUT_DB_TIMEOUT_MS))) {
      return {
        ok: false,
        reason: 'user_deleted',
        text: PRECHECKOUT_TEXT.restart,
        plan: payload.p,
        amount: query.total_amount,
        expected: invoice.stars,
      };
    }

    // Сумма сверяется со **снимком в счёте** (`invoices.stars`), а не с текущей
    // ценой плана: цену могли поменять, пока окно оплаты открыто, и отклонять
    // из-за этого уже показанный счёт — значит наказывать человека за нашу
    // правку. Здесь ловим только подмену суммы в самом запросе.
    if (query.total_amount !== invoice.stars) {
      return {
        ok: false,
        reason: 'amount_mismatch',
        text: PRECHECKOUT_TEXT.amount,
        plan: payload.p,
        amount: query.total_amount,
        expected: invoice.stars,
      };
    }

    return {
      ok: true,
      reason: 'ok',
      plan: payload.p,
      amount: query.total_amount,
      expected: invoice.stars,
    };
  }

  /** Ответ Telegram. Падение самого ответа не должно ронять вебхук. */
  private async answerSafely(queryId: string, decision: PreCheckoutDecision): Promise<boolean> {
    try {
      await this.telegram.answerPreCheckoutQuery(queryId, decision.ok, decision.text);
      return true;
    } catch (error) {
      this.logger.error('pre_checkout_answer_failed', {
        plan: decision.plan,
        reason: error instanceof Error ? error.name : 'unknown',
      });
      return false;
    }
  }

  /**
   * События `pre_checkout_*` для метрик. Ошибка записи не влияет на ответ:
   * человек уже получил свой `ok`, а событие — наша телеметрия.
   */
  private async logPreCheckoutEvents(
    decision: PreCheckoutDecision,
    payload: InvoicePayload | null,
    query: TelegramPreCheckoutQuery,
  ): Promise<void> {
    try {
      await this.events.log({
        name: 'pre_checkout_received',
        userId: payload?.u ?? null,
        props: { plan: decision.plan, amount: query.total_amount },
      });

      if (decision.ok) {
        return;
      }

      const name = decision.reason === 'timeout' ? 'pre_checkout_timeout' : 'pre_checkout_rejected';

      await this.events.log({
        name,
        userId: payload?.u ?? null,
        props: {
          reason: decision.reason,
          plan: decision.plan,
          amount: decision.amount,
          expected: decision.expected,
        },
      });
    } catch (error) {
      this.logger.warn('pre_checkout_event_failed', {
        reason: error instanceof Error ? error.name : 'unknown',
      });
    }
  }

  /**
   * Апдейт `successful_payment`: сверка, запись платежа и выдача доступа.
   *
   * Что отвечает вебхук:
   *   • `200` — платёж записан и доступ выдан (`processed`);
   *   • `200` — повтор доставки (`duplicate`);
   *   • `200` — платёж записан, но выдача упала (`deferred`): строку доведёт джоб
   *     `pending_payments_resolve`, повторять доставку бессмысленно — она упрётся
   *     в ту же ошибку;
   *   • `500` — не удалось даже записать платёж (БД недоступна). Telegram
   *     повторит, и это правильно: иначе платёж исчезнет.
   *
   * Сообщение в чат — последним и не критично (`payments.md` §3.2, п. 5).
   */
  private async handleSuccessfulPayment(
    chatId: number | null,
    telegramUserId: number | null,
    payment: TelegramSuccessfulPayment,
  ): Promise<void> {
    const outcome = await this.processPayment({ telegramUserId, payment });

    if (outcome.kind === 'deferred') {
      this.logger.warn('payment_deferred_to_job', {
        charge_tail: payment.telegram_payment_charge_id.slice(-6),
      });
      return;
    }

    if (outcome.kind !== 'processed') {
      return;
    }

    // П.5 из payments.md §3.2: сообщение не критично, ошибка не отменяет платёж.
    //
    // Раньше `sendMessage` звался без try/catch: недоступный Telegram на этом
    // шаге давал `500`, Telegram повторял доставку, повтор упирался в
    // «уже обработано», и человек оставался с доступом, но без сообщения —
    // зато с записью об ошибке в логе вебхука, по которой не понять, дошёл
    // ли платёж. Теперь платёж и доступ фиксируются, а сбой сообщения — одна
    // строка лога (итерация 25).
    if (chatId !== null) {
      try {
        await this.telegram.sendMessage(chatId, this.purchaseMessage(outcome.plan, outcome.expiresAt));
      } catch (error) {
        this.logger.error('payment_message_failed', {
          charge_tail: payment.telegram_payment_charge_id.slice(-6),
          plan: outcome.plan.code,
          reason: error instanceof Error ? error.name : 'unknown',
        });
      }
    }
  }

  /**
   * QA-11: доступ выдаётся только за платёж, который сервер сам выставлял.
   *
   * Проверки по порядку: (1) инвойс с таким `payload.k` существует и принадлежит
   * этому же пользователю, план в payload совпадает с планом инвойса;
   * (2) сумма равна цене плана; (3) план известен. Любой отказ — `200` в вебхуке
   * (иначе Telegram будет ретраить вечно), запись платежа со статусом `rejected`
   * и причиной, серверное событие `payment_rejected` и счётчик в `/admin/metrics`.
   * Возврат звёзд автоматически не делаем: это реальные деньги пользователя,
   * решение принимает владелец.
   *
   * Один и тот же путь используют вебхук и джоб `pending_payments_resolve`:
   * зависший платёж разрешается ровно теми же проверками, что и свежий.
   */
  private async processPayment(input: {
    readonly telegramUserId: number | null;
    readonly payment: TelegramSuccessfulPayment;
  }): Promise<PaymentOutcome> {
    const { payment, telegramUserId } = input;
    const payload = parseInvoicePayload(payment.invoice_payload);
    const plan = payload === null ? null : await this.plans.getPlan(payload.p);
    const chargeId = payment.telegram_payment_charge_id;

    if (payment.currency !== 'XTR') {
      await this.rejectPayment({
        code: 'amount_mismatch',
        detail: 'currency_not_xtr',
        telegramUserId,
        testPlan: plan?.testOnly === true,
        payment,
        userId: payload?.u ?? null,
        planCode: payload?.p ?? null,
        expected: plan?.stars ?? null,
      });
      return { kind: 'rejected', code: 'amount_mismatch' };
    }

    if (payload === null || plan === null) {
      await this.rejectPayment({
        code: 'unknown_plan',
        detail: payload === null ? 'payload_invalid' : 'plan_not_in_catalogue',
        telegramUserId,
        testPlan: plan?.testOnly === true,
        payment,
        userId: payload?.u ?? null,
        planCode: null,
        expected: null,
      });
      return { kind: 'rejected', code: 'unknown_plan' };
    }

    const invoice = await this.repo.findInvoiceByIdeaKey(payload.u, payload.k);
    if (invoice === null || invoice.plan_code !== payload.p) {
      await this.rejectPayment({
        code: 'no_invoice',
        detail: invoice === null ? 'invoice_missing' : 'invoice_plan_mismatch',
        telegramUserId,
        testPlan: plan?.testOnly === true,
        payment,
        userId: payload.u,
        planCode: payload.p,
        expected: invoice?.stars ?? plan.stars,
      });
      return { kind: 'rejected', code: 'no_invoice' };
    }

    // Сверка со снимком суммы в счёте, а не с текущей ценой плана: инвойс —
    // источник для уже выставленных счетов, план — только для новых. Иначе
    // правка цены отклоняла бы честный платёж по старому счёту.
    if (payment.total_amount !== invoice.stars) {
      await this.rejectPayment({
        code: 'amount_mismatch',
        detail: 'amount_differs_from_invoice',
        telegramUserId,
        testPlan: plan?.testOnly === true,
        payment,
        userId: payload.u,
        planCode: payload.p,
        expected: invoice.stars,
      });
      return { kind: 'rejected', code: 'amount_mismatch' };
    }

    // QA-15: оплата после удаления данных. Инвойс аннулируется вместе с
    // пользователем, поэтому основная проверка — его статус; проверка
    // существования пользователя закрывает гонку и старые данные.
    if (invoice.status === 'invalidated') {
      await this.rejectPayment({
        code: 'invoice_invalidated',
        detail: 'invoice_invalidated_after_delete',
        telegramUserId,
        testPlan: plan?.testOnly === true,
        payment,
        userId: payload.u,
        planCode: payload.p,
        expected: invoice.stars,
        refund: true,
      });
      return { kind: 'rejected', code: 'invoice_invalidated' };
    }

    if (!(await this.repo.userExists(payload.u))) {
      await this.rejectPayment({
        code: 'user_deleted',
        detail: 'user_missing_at_payment',
        telegramUserId,
        testPlan: plan?.testOnly === true,
        payment,
        userId: payload.u,
        planCode: payload.p,
        expected: invoice.stars,
        refund: true,
      });
      return { kind: 'rejected', code: 'user_deleted' };
    }

    // Срок из Telegram — когда он есть. Если поля нет, период прибавит
    // `upsertSubscription` к текущему `expires_at` (R-1): три оплаты подряд
    // дают три периода, а не один и тот же «сейчас + период».
    const requestedExpiresAt =
      plan.kind === 'subscription' && payment.subscription_expiration_date !== undefined
        ? new Date(payment.subscription_expiration_date * 1000)
        : null;
    const chartId = invoice.chart_id;

    // ── Фаза 1: записать платёж ────────────────────────────────────────────
    //
    // Отдельная транзакция, а не одна на всё (как было до итерации 25). Смысл:
    // деньги уже списаны Telegram, и запись о них не должна зависеть от того,
    // удастся ли выдать доступ. Если выдача упадёт, платёж останется
    // `status='paid', processed=false` — его доведёт `pending_payments_resolve`
    // (тот же путь, что у зависших доставок), а не потеряет никто.
    //
    // Упасть сама запись (БД недоступна) может — тогда исключение уходит наверх,
    // вебхук отвечает `500`, и Telegram повторяет доставку. Это осознанно:
    // недоставленный `successful_payment` хуже повторного (идемпотентность по
    // `telegram_payment_charge_id`).
    const recorded = await this.db.withTransaction(async (client) => {
      const locked = await this.repo.lockPayment(client, chargeId);

      // Повтор доставки уже обработанного платежа и повтор доставки отказа
      // (`rejected`) — оба ничего не выдают: доступ даёт только первая запись.
      if (locked !== null) {
        return { id: locked.id, processed: locked.processed, status: locked.status };
      }

      const insertedId =
        await this.repo.insertPayment(client, {
          userId: payload.u,
          // telegram_id нужен только для refundStarPayment и обнуляется при DELETE /me.
          telegramId: telegramUserId,
          planCode: payload.p,
          totalAmount: payment.total_amount,
          currency: payment.currency,
          chargeId,
          providerChargeId: payment.provider_payment_charge_id ?? null,
          invoicePayload: payment.invoice_payload,
          subscriptionExpiresAt: requestedExpiresAt,
          // Тестовый тариф отмечается на платеже: проверка суммы для него
          // та же (1 ⭐ = 1 ⭐), а вот в выручку и конверсию он не идёт.
          isTest: plan.testOnly,
        });

      // Гонка двух доставок: строку успел вставить параллельный обработчик.
      const raced = insertedId === null ? await this.repo.lockPayment(client, chargeId) : null;
      const paymentId = insertedId ?? raced?.id ?? null;

      if (paymentId === null) {
        // Записать не удалось и прочитать не удалось — это не «повтор», а
        // потеря платежа. Пусть вебхук ответит 500 и Telegram повторит.
        throw new Error('платёж не записан и не найден');
      }

      return {
        id: paymentId,
        processed: raced?.processed ?? false,
        status: raced?.status ?? 'paid',
      };
    });

    // Уже обработан или отклонён раньше — второй раз ничего не выдаём.
    if (recorded.processed || recorded.status === 'rejected') {
      this.logger.info('payment_duplicate_ignored', { charge: chargeId, status: recorded.status });
      return { kind: 'duplicate' };
    }

    // ── Фаза 2: выдать доступ ──────────────────────────────────────────────
    //
    // Выдача и отметка `processed` — по-прежнему одна транзакция: либо доступ
    // выдан и платёж закрыт, либо не произошло ничего и повтор начнёт заново.
    // Двойного продления подписки при повторе нет именно из-за этого.
    let outcome: ProcessOutcome;

    try {
      outcome = await this.db.withTransaction<ProcessOutcome>(async (client) => {
        const locked = await this.repo.lockPayment(client, chargeId);
        if (locked === null) {
          throw new Error('платёж исчез между транзакциями');
        }
        if (locked.processed || locked.status === 'rejected') {
          return { kind: 'duplicate' };
        }

        const grant = await this.grantOne(client, {
          paymentId: locked.id,
          chargeId,
          plan,
          userId: payload.u,
          chartId,
          // Срок берём из Telegram (`subscription_expiration_date`), когда он есть:
          // это официальная дата окончания, а не наша арифметика.
          subscriptionExpiresAt: requestedExpiresAt,
        });

        await this.repo.markPaymentProcessed(client, locked.id);
        await this.repo.markInvoicePaid(client, payload.u, payload.k);

        return {
          kind: 'processed',
          plan,
          expiresAt: grant.expiresAt,
          renewed: grant.renewed,
        };
      });
    } catch (error) {
      // Деньги списаны, доступ не выдан — самый тяжёлый класс. Платёж уже
      // записан (`paid`), поэтому ничего не теряется: джоб доведёт выдачу,
      // а вебхук отвечает `200`, чтобы Telegram не долбил нас повторами,
      // которые упрутся в ту же ошибку.
      this.logger.error('payment_grant_failed', {
        charge_tail: chargeId.slice(-6),
        plan: payload.p,
        amount: payment.total_amount,
        reason: error instanceof Error ? error.name : 'unknown',
      });

      await this.logEvent('payment_grant_failed', payload.u, {
        plan: payload.p,
        amount: payment.total_amount,
      });

      return { kind: 'deferred' };
    }

    if (outcome.kind === 'duplicate') {
      this.logger.info('payment_duplicate_ignored', { charge: chargeId, phase: 2 });
      return outcome;
    }

    if (plan.testOnly) {
      // Тестовая оплата владельца: доступ выдан как обычно, но в метриках это
      // не продажа (`payments.is_test`, /admin/metrics `test_payments_30d`).
      this.logger.warn('test_payment_processed', {
        charge_tail: chargeId.slice(-6),
        stars: payment.total_amount,
      });
    }

    await this.logEvent(outcome.renewed ? 'subscription_renewed' : 'payment_processed', payload.u, {
      plan: payload.p,
      stars: payment.total_amount,
      // Сюда доходят только платежи, сверенные с инвойсом и ценой плана.
      amount_matches: true,
      renewed: outcome.renewed,
    });

    return outcome;
  }

  /**
   * Событие в `events` — не критичная часть платежа.
   *
   * Падение записи события не должно превращать выданный доступ в `500` и
   * повторную доставку: деньги и права уже зафиксированы, телеметрия — вторична.
   */
  private async logEvent(
    name: string,
    userId: string | null,
    props: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    try {
      await this.events.log({ name, userId, props });
    } catch (error) {
      this.logger.warn('payment_event_failed', {
        event: name,
        reason: error instanceof Error ? error.name : 'unknown',
      });
    }
  }
  /**
   * Отказ по деньгам: платёж пишется со статусом `rejected`, доступ не выдаётся.
   *
   * В логах — только `charge_id`, суммы, код и `request_id` (его добавляет
   * логгер): ни telegram_id, ни payload пользователя.
   */
  private async rejectPayment(input: {
    readonly code: RejectReason;
    readonly detail: string;
    readonly telegramUserId: number | null;
    readonly payment: TelegramSuccessfulPayment;
    readonly userId: string | null;
    readonly planCode: PlanCode | null;
    readonly expected: number | null;
    /** План помечен `test_only` в БД: отказ по нему тоже тестовый. */
    readonly testPlan?: boolean;
    /** QA-15: отказ из-за удаления данных возвращает звёзды автоматически. */
    readonly refund?: boolean;
  }): Promise<void> {
    const chargeId = input.payment.telegram_payment_charge_id;

    this.logger.warn('payment_rejected', {
      code: input.code,
      detail: input.detail,
      charge: chargeId,
      amount: input.payment.total_amount,
      expected: input.expected,
      plan: input.planCode,
    });

    const recorded = await this.db.withTransaction(async (client) => {
      // Зависший платёж (`paid`, но доступ не выдан) уже лежит в базе: его
      // помечаем отказом, а не пытаемся вставить вторую строку с тем же charge_id.
      const updatedId = await this.repo.markPaymentRejected(client, { chargeId, reason: input.code });
      if (updatedId !== null) {
        return true;
      }

      const insertedId = await this.repo.insertRejectedPayment(client, {
        userId: input.userId,
        telegramId: input.telegramUserId,
        planCode: input.planCode,
        totalAmount: input.payment.total_amount,
        currency: input.payment.currency,
        chargeId,
        providerChargeId: input.payment.provider_payment_charge_id ?? null,
        invoicePayload: input.payment.invoice_payload,
        subscriptionExpiresAt: null,
        rejectReason: input.code,
        isTest: input.testPlan === true
      });

      // Повторная доставка того же charge_id уже записана — второй раз не считаем.
      return insertedId !== null;
    });

    if (!recorded) {
      this.logger.info('payment_rejected_duplicate_ignored', { charge: chargeId, code: input.code });
      return;
    }

    // Событие только серверное: клиент его отправить не может (контракт 1.5.3).
    await this.events.log({
      name: 'payment_rejected',
      userId: input.userId,
      props: { code: input.code, plan: input.planCode, expected: input.expected },
    });

    if (input.refund !== true) {
      return;
    }

    await this.refundRejectedPayment({
      chargeId,
      telegramUserId: input.telegramUserId,
      userId: input.userId,
      code: input.code,
    });
  }

  /**
   * Возврат по отказу QA-15. Деньги вернулись — `refunded_at` у `rejected`
   * и серверное событие `refund_issued`. Не вернулись (нет `telegram_id` или
   * Telegram отказал) — платёж остаётся `rejected` + `processed = false`,
   * попадает в `pending_payments_now`, а в событиях появляется
   * `payment_rejected` с `code = refund_failed`: это ручной разбор поддержки.
   */
  private async refundRejectedPayment(input: {
    readonly chargeId: string;
    readonly telegramUserId: number | null;
    readonly userId: string | null;
    readonly code: RejectReason;
  }): Promise<void> {
    const refunded =
      input.telegramUserId !== null &&
      (await this.telegram.refundStarPayment(input.telegramUserId, input.chargeId));

    if (!refunded) {
      this.logger.error('payment_refund_failed', {
        charge: input.chargeId,
        code: input.code,
        reason: input.telegramUserId === null ? 'no_telegram_id' : 'telegram_refused',
      });
      await this.events.log({
        name: 'payment_rejected',
        userId: input.userId,
        props: { code: 'refund_failed', plan: null, expected: null },
      });
      return;
    }

    await this.repo.markRejectedRefunded(input.chargeId);
    this.logger.info('refund_issued', { charge: input.chargeId, code: input.code });
    await this.events.log({
      name: 'refund_issued',
      userId: input.userId,
      props: { code: input.code },
    });
  }

  /** QA-15: аннулирование инвойсов делает `DELETE /me` в своей транзакции. */
  async invalidateInvoices(client: PoolClient, userId: string): Promise<number> {
    return this.repo.invalidateInvoices(client, userId);
  }

  /**
   * Довести зависший платёж до конца теми же проверками, что и вебхук:
   * доступ (если инвойс и сумма в порядке) или `rejected` (если нет).
   *
   * Возвращает `'unresolved'`, если строка исчезла или уже разобрана, и
   * бросает исключение, если выдача не удалась: тогда платёж остаётся
   * `paid`/`unprocessed`, и его забирает джоб возврата.
   */
  async resolvePending(chargeId: string): Promise<'processed' | 'rejected' | 'unresolved'> {
    const row = await this.repo.findPaymentForResolution(chargeId);

    if (row === null || row.processed || row.status !== 'paid') {
      return 'unresolved';
    }

    const outcome = await this.processPayment({
      telegramUserId: row.telegram_id === null ? null : Number(row.telegram_id),
      payment: {
        currency: row.currency,
        total_amount: row.total_amount,
        invoice_payload: row.invoice_payload ?? '',
        telegram_payment_charge_id: row.telegram_payment_charge_id,
        ...(row.provider_payment_charge_id === null
          ? {}
          : { provider_payment_charge_id: row.provider_payment_charge_id }),
        ...(row.subscription_expires_at === null
          ? {}
          : { subscription_expiration_date: Math.floor(row.subscription_expires_at.getTime() / 1000) }),
      },
    });

    return outcome.kind === 'processed' ? 'processed' : outcome.kind === 'rejected' ? 'rejected' : 'unresolved';
  }

  /** Незавершённые платежи пользователя: `DELETE /me` разрешает их инлайн. */
  async unprocessedChargesOf(userId: string): Promise<string[]> {
    const rows = await this.repo.listUnprocessedPaymentsOf(userId);
    return rows.map((row) => row.telegram_payment_charge_id);
  }

  /** Платежи, висящие дольше `minutes`, — вход джоба `pending_payments_resolve`. */
  async staleCharges(minutes: number, limit: number): Promise<string[]> {
    const rows = await this.repo.findUnprocessedPayments(minutes, limit);
    return rows.map((row) => row.telegram_payment_charge_id);
  }

  private async grantOne(
    client: PoolClient,
    input: {
      readonly paymentId: string;
      readonly chargeId: string;
      readonly plan: PlanRow;
      readonly userId: string;
      readonly chartId: string | null;
      readonly subscriptionExpiresAt: Date | null;
    },
  ): Promise<{ expiresAt: Date | null; renewed: boolean }> {
    if (input.plan.kind === 'subscription') {
      const subscription = await this.repo.upsertSubscription(client, {
        userId: input.userId,
        plan: input.plan.subscriptionPlan as 'week' | 'month' | 'year',
        requestedExpiresAt: input.subscriptionExpiresAt,
        periodSeconds: input.plan.periodSeconds,
        chargeId: input.chargeId,
      });

      const renewed =
        subscription.previousExpiresAt !== null &&
        subscription.expiresAt.getTime() > subscription.previousExpiresAt.getTime();

      this.logger.info('subscription_upserted', {
        user_id: input.userId,
        plan: input.plan.subscriptionPlan,
        // payments.md §3.3: продление обязано сдвинуть срок — проверяем и пишем в лог
        previous_expires_at: subscription.previousExpiresAt?.toISOString() ?? null,
        expires_at: subscription.expiresAt.toISOString(),
        renewed,
      });

      return { expiresAt: subscription.expiresAt, renewed };
    }

    const granted = await this.repo.grantEntitlement(client, {
      userId: input.userId,
      kind: input.plan.grant,
      chartId: input.chartId,
      // Партнёр появляется после оплаты совместимости (миграция 0005).
      partnerChartId: null,
      paymentId: input.paymentId,
    });

    if (!granted) {
      // Второй оплаты за тот же разбор быть не должно: `POST /billing/invoice`
      // такой счёт не выставляет. Но если два счёта всё же были выставлены до
      // оплаты, доступ остаётся один — второй платёж виден в `payments`
      // и разбирается возвратом, а не второй строкой `entitlements`.
      this.logger.warn('entitlement_already_granted', {
        user_id: input.userId,
        kind: input.plan.grant,
        plan: input.plan.code,
        chart_id: input.chartId,
      });
    }

    return { expiresAt: null, renewed: false };
  }

  private purchaseMessage(plan: PlanRow, expiresAt: Date | null): string {
    const title = plan.kind === 'subscription' ? plan.priceLabel : plan.title;

    return expiresAt === null
      ? `✅ Оплачено: <b>${title}</b> (${plan.stars} ⭐)\nДоступ открыт.`
      : `✅ Оплачено: <b>${title}</b> (${plan.stars} ⭐)\nПодписка действует до ${formatDate(expiresAt)}.`;
  }

  /**
   * Возврат звёзд: `refundStarPayment` + отзыв доступа (payments.md §3.5).
   * Вызывается поддержкой или джобом недоставленного товара.
   */
  /**
   * Возврат звёзд по charge_id.
   *
   * `telegramUserId` нужен, когда в строке платежа уже нет `telegram_id`:
   * после `DELETE /me` он живёт только окно возврата, а потом снимается.
   * Дальше человек пишет в поддержку — оператор берёт его id из чата и
   * передаёт сюда. Bot API всё равно проверит пару (user_id, charge_id).
   */
  async refund(
    chargeId: string,
    reason: string,
    options: { readonly telegramUserId?: number } = {},
  ): Promise<boolean> {
    const payment = await this.repo.findRefundablePayment(chargeId);

    if (payment === null || payment.status === 'refunded') {
      return false;
    }

    const telegramUserId = payment.telegram_id ?? options.telegramUserId ?? null;

    if (telegramUserId === null) {
      this.logger.warn('refund_without_telegram_id', { charge: chargeId });
      return false;
    }

    const ok = await this.telegram.refundStarPayment(Number(telegramUserId), chargeId);
    if (!ok) {
      return false;
    }

    await this.repo.registerRefund({ chargeId, reason });
    return true;
  }
}
