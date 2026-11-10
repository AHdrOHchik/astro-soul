import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { PLANS, type Plan } from '@astro-soul/shared';
import { DbService } from '../../db/db.service';
import { JsonLogger } from '../../common/logger';
import { TelegramClient } from '../telegram/telegram.client';
import { EventsRepository } from '../events/events.repository';
import { BillingRepository } from './billing.repository';
import { parseInvoicePayload } from './billing.dto';

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

type ProcessOutcome =
  | { readonly kind: 'duplicate' }
  | {
      readonly kind: 'processed';
      readonly plan: Plan;
      readonly expiresAt: Date | null;
      readonly renewed: boolean;
    };

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
    @Inject(DbService) private readonly db: DbService,
    @Inject(TelegramClient) private readonly telegram: TelegramClient,
    @Inject(EventsRepository) private readonly events: EventsRepository,
    @Inject(JsonLogger) private readonly logger: JsonLogger,
  ) {}

  /** Единая точка входа вебхука. Неизвестные апдейты молча игнорируются. */
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
   * `pre_checkout_query`: ответить за 10 с. Если товар уже выдан — всё равно
   * `ok=true` (деньги списаны, спор решается возвратом), поэтому проверяем
   * только то, что платёж вообще сможем принять.
   */
  private async handlePreCheckout(query: TelegramPreCheckoutQuery): Promise<void> {
    const payload = parseInvoicePayload(query.invoice_payload);
    const plan = payload === null ? undefined : PLANS[payload.p];

    if (payload === null || plan === undefined || query.currency !== 'XTR') {
      this.logger.warn('pre_checkout_rejected', { reason: payload === null ? 'payload' : 'plan' });
      await this.telegram.answerPreCheckoutQuery(
        query.id,
        false,
        'Товар недоступен, попробуйте ещё раз',
      );
      return;
    }

    await this.telegram.answerPreCheckoutQuery(query.id, true);
  }

  private async handleSuccessfulPayment(
    chatId: number | null,
    telegramUserId: number | null,
    payment: TelegramSuccessfulPayment,
  ): Promise<void> {
    const payload = parseInvoicePayload(payment.invoice_payload);
    const plan = payload === null ? undefined : PLANS[payload.p];

    if (payload === null || plan === undefined) {
      // Деньги списаны, но связать платёж не с чем: фиксируем charge_id для разбора
      // поддержкой. Падать с 500 нельзя — Telegram будет ретраить бесконечно.
      this.logger.error(payload === null ? 'payment_payload_invalid' : 'payment_unknown_plan', {
        charge: payment.telegram_payment_charge_id,
        amount: payment.total_amount,
      });
      return;
    }

    if (payment.currency !== 'XTR') {
      this.logger.error('payment_wrong_currency', { charge: payment.telegram_payment_charge_id });
      return;
    }

    const invoice = await this.repo.findInvoiceByIdeaKey(payload.u, payload.k);
    const amountMatches = payment.total_amount === plan.stars;
    if (!amountMatches) {
      // Оплата не совпала с ценой плана: доступ выдаём по факту оплаты,
      // но фиксируем — это повод разобраться руками, а не молчание.
      this.logger.error('payment_amount_mismatch', {
        charge: payment.telegram_payment_charge_id,
        expected: plan.stars,
        actual: payment.total_amount,
      });
    }

    const chargeId = payment.telegram_payment_charge_id;
    const requestedExpiresAt =
      plan.kind === 'subscription'
        ? new Date(
            (payment.subscription_expiration_date ??
              Math.floor(Date.now() / 1000) + plan.periodSeconds) * 1000,
          )
        : null;
    const chartId = invoice?.chart_id ?? null;

    const outcome = await this.db.withTransaction<ProcessOutcome>(async (client) => {
      const locked = await this.repo.lockPayment(client, chargeId);
      if (locked?.processed === true) {
        return { kind: 'duplicate' };
      }

      const insertedId =
        locked?.id ??
        (await this.repo.insertPayment(client, {
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
        }));

      // Гонка двух доставок: строку успел вставить параллельный обработчик.
      const paymentId = insertedId ?? (await this.repo.lockPayment(client, chargeId))?.id ?? null;
      if (paymentId === null) {
        throw new Error('платёж не найден после вставки');
      }

      const grant = await this.grantOne(client, {
        paymentId,
        chargeId,
        plan,
        userId: payload.u,
        chartId,
        // Срок берём из Telegram (`subscription_expiration_date`), когда он есть:
        // это официальная дата окончания, а не наша арифметика.
        subscriptionExpiresAt: requestedExpiresAt,
      });

      await this.repo.markPaymentProcessed(client, paymentId);
      await this.repo.markInvoicePaid(client, payload.u, payload.k);

      return {
        kind: 'processed',
        plan,
        expiresAt: grant.expiresAt,
        renewed: grant.renewed,
      };
    });

    if (outcome.kind === 'duplicate') {
      this.logger.info('payment_duplicate_ignored', { charge: chargeId });
      return;
    }

    await this.events.log({
      name: outcome.renewed ? 'subscription_renewed' : 'payment_processed',
      userId: payload.u,
      props: {
        plan: payload.p,
        stars: payment.total_amount,
        amount_matches: amountMatches,
        renewed: outcome.renewed,
      },
    });

    // П.5 из payments.md §3.2: сообщение не критично, ошибка не отменяет платёж.
    if (chatId !== null) {
      await this.telegram.sendMessage(chatId, this.purchaseMessage(outcome.plan, outcome.expiresAt));
    }
  }

  private async grantOne(
    client: PoolClient,
    input: {
      readonly paymentId: string;
      readonly chargeId: string;
      readonly plan: Plan;
      readonly userId: string;
      readonly chartId: string | null;
      readonly subscriptionExpiresAt: Date | null;
    },
  ): Promise<{ expiresAt: Date | null; renewed: boolean }> {
    if (input.plan.kind === 'subscription') {
      const subscription = await this.repo.upsertSubscription(client, {
        userId: input.userId,
        plan: input.plan.subscriptionPlan as 'week' | 'month' | 'year',
        expiresAt: input.subscriptionExpiresAt ?? new Date(Date.now() + input.plan.periodSeconds * 1000),
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

    await this.repo.grantEntitlement(client, {
      userId: input.userId,
      kind: input.plan.grant,
      chartId: input.chartId,
      // Партнёр появляется после оплаты совместимости (миграция 0005).
      partnerChartId: null,
      paymentId: input.paymentId,
    });

    return { expiresAt: null, renewed: false };
  }

  private purchaseMessage(plan: Plan, expiresAt: Date | null): string {
    const title = plan.kind === 'subscription' ? plan.priceLabel : plan.title;

    return expiresAt === null
      ? `✅ Оплачено: <b>${title}</b> (${plan.stars} ⭐)\nДоступ открыт.`
      : `✅ Оплачено: <b>${title}</b> (${plan.stars} ⭐)\nПодписка действует до ${formatDate(expiresAt)}.`;
  }

  /**
   * Возврат звёзд: `refundStarPayment` + отзыв доступа (payments.md §3.5).
   * Вызывается поддержкой или джобом недоставленного товара.
   */
  async refund(chargeId: string, reason: string): Promise<boolean> {
    const payment = await this.repo.findRefundablePayment(chargeId);

    if (payment === null || payment.status === 'refunded' || payment.telegram_id === null) {
      return false;
    }

    const ok = await this.telegram.refundStarPayment(Number(payment.telegram_id), chargeId);
    if (!ok) {
      return false;
    }

    await this.repo.registerRefund({ chargeId, reason });
    return true;
  }
}
