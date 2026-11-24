import { Inject, Injectable } from '@nestjs/common';
import {
  EMPTY_GRANT_ENTITLEMENTS,
  entitlementsForPlan,
  FREE_ENTITLEMENTS,
  type Entitlements,
  type GrantEntitlements,
  type GrantSource,
  type SubscriptionState,
} from '@astro-soul/shared';
import { DbService } from '../../db/db.service';
import { PlansRepository } from '../billing/plans.repository';

/**
 * `getEntitlements(userId)` — единственное место, где решается,
 * что можно пользователю (payments.md §4).
 *
 * Любая проверка доступа в коде обязана идти через этот сервис.
 * Проверки вида `if (plan === 'month')` в обработчиках — ошибка ревью.
 */
@Injectable()
export class EntitlementsService {
  constructor(
    @Inject(DbService) private readonly db: DbService,
    @Inject(PlansRepository) private readonly plans: PlansRepository,
  ) {}

  /**
   * Соответствие `subscriptions.plan` → слаг плана в таблице `plans`.
   *
   * Итерация 23 (дополнение): права подписки читаются из `plans.grants`, а не
   * из каталога в коде. Триал отдельного плана не имеет — доступ как у недели.
   */
  private static readonly PLAN_BY_SUBSCRIPTION: Readonly<
    Record<Exclude<SubscriptionState['plan'], 'none'>, 'week' | 'month' | 'year'>
  > = {
    trial: 'week',
    week: 'week',
    month: 'month',
    year: 'year',
  };

  /**
   * Бесплатный доступ по праву (контракт 1.6.14) — отдельный блок.
   *
   * Читается **всегда**, даже когда есть подписка: человек может иметь и
   * купленный год, и подаренные 14 дней — и «действует до» должно показывать
   * самый поздний конец, а не то, что первым попало в `ORDER BY`.
   */
  async getGrantEntitlements(userId: string): Promise<GrantEntitlements> {
    const row = await this.db.queryOne<{
      all_access_until: Date | null;
      single_reports: number;
      single_compat: number;
      founder_place: number | null;
      source: GrantSource | null;
    }>(
      `SELECT
         (SELECT max(expires_at) FROM grants
           WHERE user_id = $1 AND kind = 'all_access' AND revoked_at IS NULL
             AND starts_at IS NOT NULL AND expires_at > now()) AS all_access_until,
         (SELECT count(*)::int FROM grants
           WHERE user_id = $1 AND kind = 'single_report'
             AND consumed_at IS NULL AND revoked_at IS NULL) AS single_reports,
         (SELECT count(*)::int FROM grants
           WHERE user_id = $1 AND kind = 'single_compat'
             AND consumed_at IS NULL AND revoked_at IS NULL) AS single_compat,
         (SELECT place FROM founders WHERE user_id = $1) AS founder_place,
         -- Источник — у самого позднего действующего права: клиент показывает
         -- «доступ от партнёра» / «от друга», и это должно быть то право,
         -- которое человек получил последним.
         (SELECT source FROM grants
           WHERE user_id = $1 AND revoked_at IS NULL
             AND (expires_at IS NULL OR expires_at > now())
             AND (consumed_at IS NULL OR kind = 'all_access')
           ORDER BY created_at DESC
           LIMIT 1) AS source`,
      [userId],
    );

    if (row === null) {
      return EMPTY_GRANT_ENTITLEMENTS;
    }

    return {
      allAccessUntil: row.all_access_until?.toISOString() ?? null,
      source: row.source,
      singleReports: row.single_reports,
      singleCompat: row.single_compat,
      isFounder: row.founder_place !== null,
      founderPlace: row.founder_place,
    };
  }

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
        : await this.baseEntitlements(subscription.plan);

    const kinds = new Set(oneOff.map((row) => row.kind));
    const grants = await this.getGrantEntitlements(userId);
    // Действующее право «всё включено» даёт права годового плана, а не
    // месячного: подарок — это «попробуй всё», включая карту года, и разница
    // в цене здесь ничего не значит (это не продажа).
    const allAccess = grants.allAccessUntil !== null;

    const withAccess: Entitlements = allAccess
      ? {
          ...base,
          // `plan` намеренно остаётся тем, чем был: `'none'`, если подписки нет.
          // Грант — не подписка, и `plan: 'year'` соврал бы клиенту и метрикам.
          isActive: true,
          fullForecast: true,
          askPerDay: Math.max(base.askPerDay, 5),
          compatPerMonth: Math.max(base.compatPerMonth, 1),
          solarIncluded: true,
          // Разбор — пятая фича «всё включено», но **не** через `fullReport`
          // (1.6.19). Право на разбор считает `AccessService.reportAccess`:
          // оно зависит ещё и от карты, и от подаренных разборов, и флаг
          // `full_report` такой вопрос не описывает.
          //
          // Round44 ставил здесь `fullReport: true`, чтобы владелец «всё
          // включено» перестал получать `402 report_not_paid`. Симптом был
          // вылечен не тем полем: флаг назывался «куплен разбор», и рядом с
          // `full_report_chart_id: null` он читался как «оплачено на этой
          // карте». Теперь доступ решает дверь, а `full_report` снова отвечает
          // буквально на свой вопрос — «есть ли оплаченный или готовый разбор».
        }
      : base;

    return {
      ...withAccess,
      // «Право» и «готовый разбор» — разные вопросы (1.6.19). Здесь только
      // второе, буквально по контракту: оплаченная строка `entitlements` или
      // уже готовый разбор (он куплен навсегда). «Всё включено» и подаренные
      // разборы в этот флаг **не входят**: они дают право, а не покупку, и их
      // видно в `Me.report_access`.
      fullReport: kinds.has('report') || readyReport !== null,
      fullReportChartId: paidChart,
      compatPerMonth: Math.max(
        withAccess.compatPerMonth,
        kinds.has('compat') ? 1 : 0,
        // Одноразовое право тоже открывает экран совместимости: иначе кнопка
        // «заказать» осталась бы закрытой, хотя право уже есть.
        grants.singleCompat > 0 ? 1 : 0,
      ),
      solarIncluded: withAccess.solarIncluded || kinds.has('solar'),
    };
  }

  /**
   * Права действующей подписки — из её строки в `plans`.
   *
   * Строки нет (пустая база без сида или план удалён) — отдаём бесплатные
   * права: выдавать доступ «на глаз» хуже, чем не выдать, а `/me` не должен
   * падать из-за конфигурации.
   */
  private async baseEntitlements(
    plan: Exclude<SubscriptionState['plan'], 'none'>,
  ): Promise<Entitlements> {
    const row = await this.plans.getSubscriptionPlan(
      EntitlementsService.PLAN_BY_SUBSCRIPTION[plan],
    );

    return row === null ? FREE_ENTITLEMENTS : entitlementsForPlan(row);
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
        cancelled_at: Date | null;
      }>(
        `SELECT plan, status, expires_at, auto_renew, cancelled_at
           FROM subscriptions WHERE user_id = $1`,
        [userId],
      ),
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
        cancelled_at: null,
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
      // `auto_renew = false` — человек уже отменил (итерация 29). Доступ при
      // этом считается по `status`/`expires_at` выше и остаётся до конца
      // периода: отмена ≠ возврат.
      auto_renew: subscription.auto_renew,
      cancelled_at: subscription.cancelled_at?.toISOString() ?? null,
      stars_paid_total: starsPaidTotal,
    };
  }
}
