import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { isFounderPlanCode, type Invoice, type SubscriptionState } from '@astro-soul/shared';
import { APP_ENV } from '../../config/env.module';
import type { AppEnv } from '../../config/env';
import { ApiError, conflict, internalError, invalidFields, rateLimited } from '../../common/api-error';
import { JsonLogger } from '../../common/logger';
import type { VerifiedInitData } from '../auth/init-data';
import { UsersRepository } from '../users/users.repository';
import { ChartsRepository } from '../charts/charts.repository';
import { EntitlementsService } from '../entitlements/entitlements.service';
import { EventsRepository } from '../events/events.repository';
import { GrantsRepository } from '../grants/grants.repository';
import { SubscriptionPeriodUnsupportedError, TelegramClient } from '../telegram/telegram.client';
import {
  XTR_SUBSCRIPTION_PERIOD_SECONDS,
  invoiceParamsViolation,
  subscriptionPeriodSupported,
} from '../telegram/invoice-params';
import { BillingRepository } from './billing.repository';
import { buildInvoicePayload, parseInvoiceRequest, planNotAvailable } from './billing.dto';
import { planOffers, type PlanOffer } from './plan-offers';
import { PlansRepository, type PlanRow } from './plans.repository';
import { SubscriptionCancelService, type CancelAutoRenewResult } from './subscription-cancel.service';

/** Антифрод-лимиты из payments.md §5. */
export const INVOICES_PER_HOUR = 3;
export const INVOICES_PER_DAY = 10;
/** Счёт, выставленный за сутки, ещё не оплачен и годится для повтора. */
export const REUSE_INVOICE_WINDOW = '1 day';

@Injectable()
export class BillingService {
  constructor(
    @Inject(BillingRepository) private readonly repo: BillingRepository,
    @Inject(PlansRepository) private readonly plans: PlansRepository,
    @Inject(UsersRepository) private readonly users: UsersRepository,
    @Inject(ChartsRepository) private readonly charts: ChartsRepository,
    @Inject(EntitlementsService) private readonly entitlements: EntitlementsService,
    @Inject(GrantsRepository) private readonly grants: GrantsRepository,
    @Inject(TelegramClient) private readonly telegram: TelegramClient,
    @Inject(EventsRepository) private readonly events: EventsRepository,
    @Inject(JsonLogger) private readonly logger: JsonLogger,
    @Inject(APP_ENV) private readonly env: AppEnv,
    @Inject(SubscriptionCancelService) private readonly subscriptionCancel: SubscriptionCancelService,
  ) {}

  /**
   * `GET /billing/plans`: витрина для клиента.
   *
   * Авторизация здесь не потому, что список личный, а потому, что весь API
   * закрыт initData: витрина — часть приложения, а не публичная страница.
   * Флаг читается на каждый запрос, поэтому прокси обязан не кэшировать ответ
   * (`Cache-Control: no-store` ставит контроллер): иначе включённый на стенде
   * флаг не появится у клиента до истечения кэша.
   */
  async listPlans(): Promise<readonly PlanOffer[]> {
    // Цена и тексты — строкой из `plans` (единственный источник). Кэша нет:
    // правка цены в БД действует на следующий же запрос, без перезапуска API.
    const rows = await this.plans.listPlans(this.env.PAYMENTS_TEST_PLANS === '1');
    return planOffers(rows);
  }

  /**
   * `POST /billing/invoice`: цена берётся из таблицы `plans`, а не из запроса.
   * Один и тот же план в пределах 5 минут отдаёт уже созданную ссылку —
   * защита от двойного тапа, а не блокировка (payments.md §5).
   */
  async createInvoice(auth: VerifiedInitData, body: unknown): Promise<Invoice> {
    const { planCode, chartId } = parseInvoiceRequest(body);

    // Пользователь нужен раньше плана: цена основателя (1.6.14) продаётся
    // только тому, у кого есть место в `founders`, и проверка идёт по `user_id`.
    const { userId } = await this.users.ensureUser({
      telegramUserId: auth.telegramUserId,
      languageCode: auth.user.language_code,
    });

    // План — строка из `plans`: цена, тексты и права только оттуда.
    const plan = await this.resolveSellablePlan(planCode, userId);

    // Полный разбор покупается для конкретной карты: без `chart_id` платёж
    // пришлось бы «прикреплять» к первой карте задним числом — это сюрприз,
    // из-за которого пишут в поддержку (решение владельца, контракт 1.5.2).
    if (plan.kind === 'one_off' && plan.grant === 'report' && chartId === null) {
      throw invalidFields(
        [{ field: 'chart_id', message: 'Выбери карту, для которой покупаешь разбор' }],
        { reason: 'chart_required_for_report' },
      );
    }

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

    // Двойная покупка совместимости (итерация 23): товар разовый и не
    // привязан к карте, поэтому проверка идёт по пользователю. Те же 422 и
    // тот же `reason`, что у `POST /compatibility`: клиенту не нужно
    // различать, на каком экране его остановили. Поле `chart_id` — потому что
    // подсвечивать надо выбор пары, а не тариф.
    if (plan.kind === 'one_off' && plan.grant === 'compat' && (await this.repo.hasUnusedCompatGrant(userId))) {
      this.logger.info('invoice_refused_already_owned', {
        user_id: userId,
        plan: planCode,
      });
      // Собираем ответ руками, а не через `invalidFields`: тот перезаписывает
      // `details`, и `details.reason` (на него смотрит контракт 1.6.0) из него
      // пропал бы — остался бы только `field_errors`.
      throw new ApiError('VALIDATION_FAILED', 422, {
        message: 'Совместимость уже куплена — закажи разбор пары',
        reason: 'compat_already_owned',
        details: {
          reason: 'compat_already_owned',
          field_errors: [
            { field: 'chart_id', message: 'Совместимость уже куплена — закажи разбор пары' },
          ],
        },
      });
    }

    // Б-3: сначала переиспользуем уже выставленный счёт — иначе лимит
    // антифрода запирает человека на час ровно тогда, когда он готов платить,
    // хотя счёт на этот план у него уже есть.
    const recent = await this.repo.findReusableInvoice(userId, planCode, chartId, REUSE_INVOICE_WINDOW);
    if (recent !== null) {
      this.logger.info('invoice_reused', { user_id: userId, plan: planCode });
      // Сумма — снимок из счёта, а не текущая цена: именно её человек увидит
      // в окне Telegram, и именно с ней сверяется платёж.
      return this.toInvoice(plan, recent.invoice_link, recent.stars);
    }

    await this.assertAntifraudLimits(userId);

    const idemKey = randomUUID();
    const payload = buildInvoicePayload({ p: planCode, u: userId, k: idemKey });

    const prices = [{ label: plan.priceLabel, amount: plan.stars }];
    const subscriptionPeriod = plan.kind === 'subscription' ? plan.periodSeconds : undefined;

    // В счёт уходит **только** `invoice_title`: короткое название из своей
    // колонки, отдельно от `title` и `paywall_title` (итерация 26).
    const invoiceTitle = plan.invoiceTitle;

    // Лимиты Bot API проверяются до вызова: иначе Telegram отвечает `400`, наш
    // клиент превращает это в `502`, и в логе остаётся «telegram_method_failed»
    // без единого намёка на то, что дело в длине названия (итерация 25).
    const violation = invoiceParamsViolation({
      title: invoiceTitle,
      description: plan.description,
      payload,
      prices,
      ...(subscriptionPeriod === undefined ? {} : { subscriptionPeriod }),
    });

    if (violation !== null && violation.field === 'title') {
      // Наша ошибка данных, а не отказ платёжной системы: человеку нельзя
      // показывать «внутренняя ошибка», а владельцу — искать причину в
      // Telegram. `409` говорит ровно то, что случилось: тариф так не
      // выставить, пока не поправят название счёта.
      this.logger.error('invoice_title_invalid', {
        plan: planCode,
        actual: violation.actual,
        limit: violation.limit,
      });
      throw conflict({
        reason: 'plan_invoice_title_invalid',
        // То же поле в теле, что обещает контракт 1.6.2: фронт может отличить
        // «тариф так не продаётся» от «внутренняя ошибка» без разбора текста.
        details: { reason: 'plan_invoice_title_invalid' },
        message:
          'Этот тариф временно нельзя оплатить: неверно задано название счёта. Выберите другой тариф.',
        logFields: { plan: planCode, actual: violation.actual, limit: violation.limit },
      });
    }

    if (violation !== null) {
      this.logger.error('invoice_params_invalid', {
        plan: planCode,
        field: violation.field,
        actual: violation.actual,
        limit: violation.limit,
      });
      throw internalError({
        reason: 'invoice_params_invalid',
        logFields: { plan: planCode, field: violation.field },
      });
    }

    // Звёздная подписка у Telegram бывает только на 30 дней. Что делать с
    // недельным и годовым тарифом, решает владелец (`payments.md` §3.6,
    // варианты A/B/C), поэтому каталог здесь не переписывается: отказ
    // приходит от Bot API и превращается в понятный `409` ниже. Лог — заранее,
    // чтобы причина была видна и у удачного вызова (там её больше нет).
    if (!subscriptionPeriodSupported(subscriptionPeriod)) {
      this.logger.warn('subscription_period_unsupported', {
        plan: planCode,
        period_seconds: subscriptionPeriod ?? null,
        allowed_seconds: XTR_SUBSCRIPTION_PERIOD_SECONDS,
      });
    }

    let invoiceLink: string;
    try {
      invoiceLink = await this.telegram.createInvoiceLink({
        title: invoiceTitle,
        description: plan.description,
        payload,
        prices,
        ...(subscriptionPeriod === undefined ? {} : { subscriptionPeriod }),
      });
    } catch (error) {
      // Платформа не принимает такой период — это не сбой оплаты, а тариф,
      // который так не продаётся. Человеку нужен внятный текст и выбор
      // месячного, а не «внутренняя ошибка» и не повтор той же кнопки.
      if (!(error instanceof SubscriptionPeriodUnsupportedError)) {
        throw error;
      }
      throw conflict({
        reason: 'plan_period_unsupported',
        message:
          'Этот тариф сейчас нельзя оплатить: Telegram поддерживает звёздные подписки только на 30 дней. Выберите месячную.',
        logFields: { plan: planCode, period_seconds: subscriptionPeriod ?? null },
      });
    }

    await this.repo.createInvoice({
      userId,
      planCode,
      idemKey,
      payload,
      invoiceLink,
      chartId,
      // Снимок суммы: правка цены, пока окно оплаты открыто, не должна
      // отклонять уже выставленный счёт.
      stars: plan.stars,
    });
    await this.events.log({
      name: 'invoice_created',
      userId,
      props: { plan: planCode, stars: plan.stars, has_chart: chartId !== null },
    });

    if (plan.testOnly) {
      // Видно в логах, не в метриках: тестовый счёт — не продажа.
      this.logger.warn('invoice_created_test_plan', { user_id: userId, plan: planCode });
    }

    return this.toInvoice(plan, invoiceLink, plan.stars);
  }

  /**
   * План, который можно продать сейчас.
   *
   * Один ответ `422` на три случая — кода нет в БД, план выключен
   * (`is_active = false`) и тестовый тариф при выключенном флаге: клиент не
   * должен различать «нет такого» и «есть, но не для тебя».
   */
  private async resolveSellablePlan(planCode: string, userId: string): Promise<PlanRow> {
    const plan = await this.plans.getPlan(planCode);

    if (plan === null) {
      planNotAvailable();
    }

    // Цена основателя (1.6.14): строка `is_active = false`, потому что она не
    // для каталога, но продаётся — и только тому, у кого есть место в
    // `founders`. Проверка серверная: клиент может попросить `founder_month`
    // сколько угодно раз, и без места получит тот же `422`, что и за
    // несуществующий тариф.
    if (isFounderPlanCode(planCode)) {
      const place = await this.grants.founderPlace(userId);

      if (place === null) {
        planNotAvailable();
      }

      return plan;
    }

    if (plan.testOnly) {
      if (this.env.PAYMENTS_TEST_PLANS !== '1') {
        planNotAvailable();
      }
    } else if (!plan.active) {
      planNotAvailable();
    }

    return plan;
  }

  /**
   * `POST /subscription/cancel` (итерация 29).
   *
   * `user_id` — псевдонимный ключ субъекта, тот же, что у подписки и платежей:
   * его считает `UsersRepository`, поэтому контроллер не знает про `pepper`.
   * `ensureUser` не нужен — строку подписки ищем по `user_id`, а если её нет,
   * это и есть `no_active_subscription`.
   */
  async cancelSubscription(auth: VerifiedInitData): Promise<CancelAutoRenewResult> {
    return this.subscriptionCancel.cancelAutoRenew(this.users.userIdFor(auth.telegramUserId));
  }

  /** `GET /billing/subscription` — та же правда, что в `/me`. */
  async getSubscription(auth: VerifiedInitData): Promise<SubscriptionState> {
    const { userId } = await this.users.ensureUser({
      telegramUserId: auth.telegramUserId,
      languageCode: auth.user.language_code,
    });

    return this.entitlements.getSubscriptionState(userId);
  }

  private toInvoice(plan: PlanRow, invoiceLink: string, stars: number): Invoice {
    return {
      invoice_link: invoiceLink,
      // `plan_code` в контракте — `OrderablePlanCode` (строка): каталог
      // `PlanCode` остался закрытым перечислением, а тестовый код приезжает
      // сюда без приведений, честно.
      plan_code: plan.code,
      stars,
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
