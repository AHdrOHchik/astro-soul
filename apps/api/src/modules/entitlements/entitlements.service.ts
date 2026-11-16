import { Inject, Injectable } from '@nestjs/common';
import {
  entitlementsForPlan,
  FREE_ENTITLEMENTS,
  PLANS,
  type Entitlements,
  type PlanCode,
  type SubscriptionState,
} from '@astro-soul/shared';
import { DbService } from '../../db/db.service';

/**
 * `getEntitlements(userId)` — единственное место, где решается,
 * что можно пользователю (payments.md §4).
 *
 * Любая проверка доступа в коде обязана идти через этот сервис.
 * Проверки вида `if (plan === 'month')` в обработчиках — ошибка ревью.
 */
@Injectable()
export class EntitlementsService {
  constructor(@Inject(DbService) private readonly db: DbService) {}

  /** Соответствие `subscriptions.plan` → план из packages/shared. */
  private static readonly PLAN_BY_SUBSCRIPTION: Readonly<
    Record<Exclude<SubscriptionState['plan'], 'none'>, PlanCode>
  > = {
    // Триал отдельного плана в payments.md не имеет: доступ как у недели.
    trial: 'week_149',
    week: 'week_149',
    month: 'month_399',
    year: 'year_2990',
  };

  async getEntitlements(userId: string): Promise<Entitlements> {
    const [subscription, oneOff, readyReport] = await Promise.all([
      this.db.queryOne<{
        plan: Exclude<SubscriptionState['plan'], 'none'>;
        status: string;
        expires_at: Date;
      }>(
        `SELECT plan, status, expires_at
           FROM subscriptions
          WHERE user_id = $1 AND status = 'active' AND expires_at > now()`,
        [userId],
      ),
      this.db.query<{ kind: 'report' | 'compat' | 'solar' }>(
        `SELECT DISTINCT kind
           FROM entitlements
          WHERE user_id = $1
            AND status = 'active'
            AND (expires_at IS NULL OR expires_at > now())`,
        [userId],
      ),
      // Готовый разбор — тоже доступ: он уже куплен, даже если запись
      // `entitlements` успела истечь (разовый продукт живёт вечно).
      this.db.queryOne<{ one: number }>(
        `SELECT 1 AS one FROM reports
          WHERE user_id = $1 AND status = 'ready' AND kind = 'report'
          LIMIT 1`,
        [userId],
      ),
    ]);

    // Б-1: `full_report` отвечает на вопрос «есть ли оплаченный разбор», а
    // `full_report_chart_id` — «по какой карте». Фронт иначе считает новую
    // карту оплаченной и ведёт человека на 402.
    const paidChart = await this.fullReportChartId(userId);

    const base =
      subscription === null
        ? FREE_ENTITLEMENTS
        : entitlementsForPlan(PLANS[EntitlementsService.PLAN_BY_SUBSCRIPTION[subscription.plan]]);

    const kinds = new Set(oneOff.map((row) => row.kind));

    return {
      ...base,
      fullReport: base.fullReport || kinds.has('report') || readyReport !== null,
      fullReportChartId: paidChart,
      compatPerMonth: Math.max(base.compatPerMonth, kinds.has('compat') ? 1 : 0),
      solarIncluded: base.solarIncluded || kinds.has('solar'),
    };
  }

  /**
   * Карта, за которую оплачен полный разбор.
   *
   * Основной источник — активная запись `entitlements (kind = 'report')`:
   * товар привязан к карте с 1.5.2. Если запись истекла/отозвана, но готовый
   * разбор остался (он куплен навсегда), берём карту из `reports` — иначе
   * `full_report = true` без карты снова выглядел бы как «оплачено всё».
   */
  async fullReportChartId(userId: string): Promise<string | null> {
    const oneOff = await this.db.queryOne<{ chart_id: string | null }>(
      `SELECT chart_id
         FROM entitlements
        WHERE user_id = $1 AND kind = 'report' AND status = 'active'
          AND (expires_at IS NULL OR expires_at > now())
        ORDER BY granted_at DESC
        LIMIT 1`,
      [userId],
    );

    if (oneOff?.chart_id !== null && oneOff?.chart_id !== undefined) {
      return oneOff.chart_id;
    }

    const ready = await this.db.queryOne<{ chart_id: string | null }>(
      `SELECT chart_id FROM reports
        WHERE user_id = $1 AND status = 'ready' AND kind = 'report'
          AND chart_id IS NOT NULL
        ORDER BY created_at DESC
        LIMIT 1`,
      [userId],
    );

    return ready?.chart_id ?? null;
  }

  /** Состояние подписки для `GET /me` (контракт `SubscriptionState`). */
  async getSubscriptionState(userId: string): Promise<SubscriptionState> {
    const [subscription, paid] = await Promise.all([
      this.db.queryOne<{
        plan: 'trial' | 'week' | 'month' | 'year';
        status: 'active' | 'expired' | 'cancelled';
        expires_at: Date;
        auto_renew: boolean;
      }>(`SELECT plan, status, expires_at, auto_renew FROM subscriptions WHERE user_id = $1`, [
        userId,
      ]),
      this.db.queryOne<{ stars: string | null }>(
        `SELECT COALESCE(SUM(total_amount), 0)::text AS stars
           FROM payments
          WHERE user_id = $1 AND status IN ('paid', 'processed')`,
        [userId],
      ),
    ]);

    const starsPaidTotal = Number(paid?.stars ?? '0');

    if (subscription === null) {
      return {
        plan: 'none',
        is_active: false,
        expires_at: null,
        auto_renew: false,
        stars_paid_total: starsPaidTotal,
      };
    }

    const isActive = subscription.status === 'active' && subscription.expires_at.getTime() > Date.now();

    return {
      plan: subscription.plan,
      // Истёкшая подписка остаётся в ответе, но не даёт доступа:
      // отдельный джоб помечает её `expired` (payments.md §3.4).
      is_active: isActive,
      expires_at: subscription.expires_at.toISOString(),
      auto_renew: subscription.auto_renew,
      stars_paid_total: starsPaidTotal,
    };
  }
}
