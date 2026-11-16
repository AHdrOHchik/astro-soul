import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PLANS, type Invoice, type PlanCodeName, type SubscriptionState } from '@astro-soul/shared';
import { APP_ENV } from '../../config/env.module';
import type { AppEnv } from '../../config/env';
import { invalidFields, rateLimited } from '../../common/api-error';
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
/** Счёт, выставленный за сутки, ещё не оплачен и годится для повтора. */
export const REUSE_INVOICE_WINDOW = '1 day';

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
    @Inject(APP_ENV) private readonly env: AppEnv,
  ) {}

  /**
   * `POST /billing/invoice`: цена берётся из `PLANS`, а не из запроса.
   * Один и тот же план в пределах 5 минут отдаёт уже созданную ссылку —
   * защита от двойного тапа, а не блокировка (payments.md §5).
   */
  async createInvoice(auth: VerifiedInitData, body: unknown): Promise<Invoice> {
    // Тестовые тарифы (`test_1` за 1 ⭐) существуют только при явном флаге —
    // иначе `parseInvoiceRequest` отвечает `422`, как будто плана нет.
    const { planCode, chartId } = parseInvoiceRequest(body, {
      testPlansEnabled: this.env.PAYMENTS_TEST_PLANS === '1',
    });
    const plan = PLANS[planCode];

    const { userId } = await this.users.ensureUser({
      telegramUserId: auth.telegramUserId,
      languageCode: auth.user.language_code,
    });

    if (chartId !== null) {
      const chart = await this.charts.findOwnedBy(chartId, userId);
      if (chart === null) {
        // Б-2: контракт обещает 422 «чужая карта», а не 404 «обнови
        // приложение». Человек ничего не обновлял — приложение исправно.
        throw invalidFields(
          [{ field: 'chart_id', message: 'Карта не найдена' }],
          { reason: 'chart_not_found' },
        );
      }

      // Двойная покупка разбора. Проверка смотрит на доступ, а не на цену и не
      // на «тестовый» признак: на тарифе за 1 ⭐ она обязана срабатывать так же,
      // как на 149 ⭐, иначе тест не проверяет то, ради чего он.
      if (plan.kind === 'one_off' && plan.grant === 'report' && (await this.repo.hasActiveReportGrant(userId, chartId))) {
        this.logger.info('invoice_refused_already_owned', { user_id: userId, plan: planCode, chart_id: chartId });
        throw invalidFields(
          [{ field: 'chart_id', message: 'Разбор для этой карты уже куплен — открой его' }],
          { reason: 'report_already_owned' },
        );
      }
    }

    // Б-3: сначала переиспользуем уже выставленный счёт — иначе лимит
    // антифрода запирает человека на час ровно тогда, когда он готов платить,
    // хотя счёт на этот план у него уже есть.
    const recent = await this.repo.findReusableInvoice(userId, planCode, chartId, REUSE_INVOICE_WINDOW);
    if (recent !== null) {
      this.logger.info('invoice_reused', { user_id: userId, plan: planCode });
      return this.toInvoice(planCode, recent.invoice_link);
    }

    await this.assertAntifraudLimits(userId);

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

    if (plan.testOnly) {
      // Видно в логах, не в метриках: тестовый счёт — не продажа.
      this.logger.warn('invoice_created_test_plan', { user_id: userId, plan: planCode });
    }

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
      // Тестовый код в контракт не входит намеренно (`PlanCode` — каталог для
      // клиента): приведение узкое и только для ответа владельцу, который сам
      // включил флаг. Молча расширять enum контракта ради теста — хуже.
      plan_code: planCode as PlanCodeName,
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

    const byDay = day >= INVOICES_PER_DAY;
    if (hour >= INVOICES_PER_HOUR || byDay) {
      // Б-3: `reset_at` — когда счёт снова можно создать. Для часового лимита
      // это момент, когда самый старый счёт выйдет из окна; для суточного —
      // то же по суткам.
      const resetAt = await this.repo.invoiceLimitResetAt(userId, byDay ? '1 day' : '1 hour');
      await this.events.log({
        name: 'invoice_rate_limited',
        userId,
        props: { hour, day },
      });
      throw rateLimited({
        message: byDay
          ? 'Слишком много счетов за сутки. Попробуй завтра или открой уже созданный счёт'
          : 'Слишком много счетов за час. Попробуй позже или открой уже созданный счёт',
        reason: 'invoice_limits',
        details: {
          hour_limit: INVOICES_PER_HOUR,
          day_limit: INVOICES_PER_DAY,
          reset_at: resetAt.toISOString(),
        },
      });
    }
  }
}
