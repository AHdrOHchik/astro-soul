import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PLANS, type Invoice, type SubscriptionState } from '@astro-soul/shared';
import { notFound, rateLimited } from '../../common/api-error';
import { JsonLogger } from '../../common/logger';
import type { VerifiedInitData } from '../auth/init-data';
import { UsersRepository } from '../users/users.repository';
import { ChartsRepository } from '../charts/charts.repository';
import { EntitlementsService } from '../entitlements/entitlements.service';
import { EventsRepository } from '../events/events.repository';
import { TelegramClient } from '../telegram/telegram.client';
import { BillingRepository } from './billing.repository';
import { buildInvoicePayload, parseInvoiceRequest } from './billing.dto';

/** Антифрод-лимиты из payments.md §5. */
export const INVOICES_PER_HOUR = 3;
export const INVOICES_PER_DAY = 10;
export const SAME_PLAN_WINDOW = '5 minutes';

@Injectable()
export class BillingService {
  constructor(
    @Inject(BillingRepository) private readonly repo: BillingRepository,
    @Inject(UsersRepository) private readonly users: UsersRepository,
    @Inject(ChartsRepository) private readonly charts: ChartsRepository,
    @Inject(EntitlementsService) private readonly entitlements: EntitlementsService,
    @Inject(TelegramClient) private readonly telegram: TelegramClient,
    @Inject(EventsRepository) private readonly events: EventsRepository,
    @Inject(JsonLogger) private readonly logger: JsonLogger,
  ) {}

  /**
   * `POST /billing/invoice`: цена берётся из `PLANS`, а не из запроса.
   * Один и тот же план в пределах 5 минут отдаёт уже созданную ссылку —
   * защита от двойного тапа, а не блокировка (payments.md §5).
   */
  async createInvoice(auth: VerifiedInitData, body: unknown): Promise<Invoice> {
    const { planCode, chartId } = parseInvoiceRequest(body);
    const plan = PLANS[planCode];

    const { userId } = await this.users.ensureUser({
      telegramUserId: auth.telegramUserId,
      languageCode: auth.user.language_code,
    });

    if (chartId !== null) {
      const chart = await this.charts.findOwnedBy(chartId, userId);
      if (chart === null) {
        throw notFound({ reason: 'chart_not_found' });
      }
    }

    await this.assertAntifraudLimits(userId);

    const recent = await this.repo.findRecentInvoice(userId, planCode, SAME_PLAN_WINDOW);
    if (recent !== null) {
      this.logger.info('invoice_reused', { user_id: userId, plan: planCode });
      return this.toInvoice(planCode, recent.invoice_link);
    }

    const idemKey = randomUUID();
    const payload = buildInvoicePayload({ p: planCode, u: userId, k: idemKey });

    const invoiceLink = await this.telegram.createInvoiceLink({
      title: plan.title,
      description: plan.description,
      payload,
      prices: [{ label: plan.priceLabel, amount: plan.stars }],
      ...(plan.kind === 'subscription' ? { subscriptionPeriod: plan.periodSeconds } : {}),
    });

    await this.repo.createInvoice({ userId, planCode, idemKey, payload, invoiceLink, chartId });
    await this.events.log({
      name: 'invoice_created',
      userId,
      props: { plan: planCode, stars: plan.stars, has_chart: chartId !== null },
    });

    return this.toInvoice(planCode, invoiceLink);
  }

  /** `GET /billing/subscription` — та же правда, что в `/me`. */
  async getSubscription(auth: VerifiedInitData): Promise<SubscriptionState> {
    const { userId } = await this.users.ensureUser({
      telegramUserId: auth.telegramUserId,
      languageCode: auth.user.language_code,
    });

    return this.entitlements.getSubscriptionState(userId);
  }

  private toInvoice(planCode: keyof typeof PLANS, invoiceLink: string): Invoice {
    const plan = PLANS[planCode];

    return {
      invoice_link: invoiceLink,
      plan_code: planCode,
      stars: plan.stars,
      is_subscription: plan.kind === 'subscription',
      subscription_period_sec: plan.kind === 'subscription' ? plan.periodSeconds : null,
    };
  }

  private async assertAntifraudLimits(userId: string): Promise<void> {
    const [hour, day] = await Promise.all([
      this.repo.countInvoicesSince(userId, '1 hour'),
      this.repo.countInvoicesSince(userId, '1 day'),
    ]);

    if (hour >= INVOICES_PER_HOUR || day >= INVOICES_PER_DAY) {
      await this.events.log({
        name: 'invoice_rate_limited',
        userId,
        props: { hour, day },
      });
      throw rateLimited({ reason: 'invoice_limits', details: { hour_limit: INVOICES_PER_HOUR } });
    }
  }
}
