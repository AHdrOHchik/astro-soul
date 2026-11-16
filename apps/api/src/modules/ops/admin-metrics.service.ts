import { Inject, Injectable } from '@nestjs/common';
import { DbService } from '../../db/db.service';
import { APP_ENV } from '../../config/env.module';
import type { AppEnv } from '../../config/env';
import { breakerState, validationStreak, type ReportHistoryRow } from '../reports/breaker';

/**
 * Метрики продукта (`GET /admin/metrics`, контракт 1.4.0).
 *
 * Принципы:
 *   • только агрегаты, ни одного ПДн и ни одного telegram_id;
 *   • воронка и счётчики событий считаются по `events.occurred_at` —
 *     клиентскому времени, — потому что батч может прийти с задержкой до
 *     суток, и без этого вчерашние шаги попадали бы в сегодняшний день.
 *     У серверных событий (платежи) клиентского времени нет, для них берём
 *     `created_at`: `COALESCE(occurred_at, created_at)`.
 */
export interface ProductMetrics {
  readonly mau: number;
  readonly paying: number;
  readonly conversion_to_paid: number;
  readonly churn_30d: number;
  readonly stars_received_30d: number;
  /** Стоимость LLM в рублях за 30 дней — по `reports.llm_cost_rub`. */
  readonly llm_cost_rub_30d: number;
  readonly reports_failed_30d: number;
  /**
   * Circuit breaker разборов (итерация 17): сколько провалов валидации подряд
   * и закрыт ли приём новых разборов. Без этого массовый провал был виден
   * только как «failed» в логах — и молча жёг бюджет.
   */
  readonly reports_validation_streak: number;
  readonly reports_breaker_open: boolean;
  /** Когда истекла последняя серия (`null` — провалов не было). */
  readonly reports_breaker_last_failed_at: string | null;
  /** QA-11: платежи, по которым доступ не выдан. */
  readonly payments_rejected_30d: number;
  readonly amount_mismatch_30d: number;
  readonly refunded_30d: number;
  readonly pending_payments_now: number;
  /** Задача A: сколько отмен автопродления в Telegram не прошло за 30 дней. */
  readonly subscription_cancel_failed_30d: number;
  /** Сколько отменённых подписок всё ещё ждут повтора в Telegram. */
  readonly subscriptions_cancelled_pending_telegram: number;
  /**
   * Платежи по тестовому тарифу (`test_1`) за 30 дней — отдельная цифра, а не
   * часть выручки: владелец должен видеть свою тестовую звезду, чтобы не
   * забыть выключить `PAYMENTS_TEST_PLANS`.
   */
  readonly test_payments_30d: number;
  /**
   * Включены ли тестовые тарифы **сейчас** (`PAYMENTS_TEST_PLANS=1`).
   *
   * `test_payments_30d` отвечает на вопрос «были ли тестовые платежи», а этот
   * флаг — «продаётся ли сейчас за 1 ⭐». На проде `true` значит забытый флаг:
   * витрина отдаёт тарифы за звезду любой минуты, пока его не снимут.
   */
  readonly test_plans_active: boolean;
  readonly events_30d: Readonly<Record<string, number>>;
  readonly funnel_30d: Readonly<Record<string, number>>;
  /**
   * Совместимость (итерация 23). Отдельные цифры, а не «reports + compat»:
   * у продукта свой брейкер, свой потолок стоимости и своя квота, и общий
   * счётчик скрыл бы, что продаётся, а что нет.
   */
  readonly compat_ready_30d: number;
  readonly compat_failed_30d: number;
  /** Сколько совместимостей можно выдать прямо сейчас (кредиты + окна подписок). */
  readonly compat_credits_left: number;
  readonly compat_validation_streak: number;
  readonly compat_breaker_open: boolean;
}

/** Шаги воронки: ровно они попадают в `funnel_30d`. */
export const FUNNEL_STEPS = [
  'app_open',
  'consent_accepted',
  'chart_created',
  'checkout_opened',
  'payment_succeeded',
] as const;

const WINDOW = "interval '30 days'";
/** Время события: клиентское, а для серверных — время записи. */
const HAPPENED_AT = 'COALESCE(occurred_at, created_at)';

function ratio(part: number, total: number): number {
  return total === 0 ? 0 : Math.round((part / total) * 1000) / 1000;
}

@Injectable()
export class AdminMetricsService {
  constructor(
    @Inject(DbService) private readonly db: DbService,
    @Inject(APP_ENV) private readonly env: AppEnv,
  ) {}

  async getMetrics(): Promise<ProductMetrics> {
    const [
      activity,
      events,
      funnel,
      subscriptions,
      payments,
      reports,
      cost,
      history,
      compat,
      compatHistory,
      telegramCancel,
    ] = await Promise.all([
        this.db.queryOne<{ mau: number }>(
          `SELECT count(DISTINCT user_id)::int AS mau
             FROM events
            WHERE user_id IS NOT NULL
              AND ${HAPPENED_AT} >= now() - ${WINDOW}`,
        ),
        this.db.query<{ name: string; total: number }>(
          `SELECT name, count(*)::int AS total
             FROM events
            WHERE ${HAPPENED_AT} >= now() - ${WINDOW}
            GROUP BY name
            ORDER BY total DESC`,
        ),
        this.db.query<{ name: string; users: number }>(
          `SELECT name, count(DISTINCT user_id)::int AS users
             FROM events
            WHERE user_id IS NOT NULL
              AND name = ANY($1::text[])
              AND ${HAPPENED_AT} >= now() - ${WINDOW}
            GROUP BY name`,
          [FUNNEL_STEPS],
        ),
        this.db.queryOne<{ paying: number; churned_30d: number; base: number }>(
          // Подписка, оплаченная тестовым тарифом, — не продажа: в `paying`
          // (а значит, и в конверсии) она не участвует. Признак берём с
          // платежа по charge_id подписки: у `subscriptions` своего флага нет
          // намеренно — «тестовость» это свойство платежа, а не доступа.
          `SELECT
             count(*) FILTER (
               WHERE s.status = 'active' AND s.expires_at > now() AND t.id IS NULL
             )::int AS paying,
             count(*) FILTER (
               WHERE s.status IN ('expired', 'cancelled')
                 AND s.updated_at >= now() - ${WINDOW}
                 AND t.id IS NULL
             )::int AS churned_30d,
             count(*) FILTER (WHERE t.id IS NULL)::int AS base
           FROM subscriptions s
           LEFT JOIN payments t
             ON t.telegram_payment_charge_id = s.telegram_payment_charge_id
            AND t.is_test`,
        ),
        this.db.queryOne<{
          stars: number;
          rejected: number;
          mismatch: number;
          refunded: number;
          pending: number;
          test: number;
        }>(
          // `rejected` — деньги не за доступ: в выручку не попадают (QA-11).
          // `is_test` исключён из всех денежных агрегатов: тестовая звезда
          // владельца — не выручка, не отказ и не «зависший платёж».
          `SELECT
             COALESCE(sum(total_amount) FILTER (
               WHERE status NOT IN ('refunded', 'rejected')
                 AND paid_at >= now() - ${WINDOW}
                 AND NOT is_test
             ), 0)::int AS stars,
             count(*) FILTER (
               WHERE status = 'rejected' AND paid_at >= now() - ${WINDOW} AND NOT is_test
             )::int AS rejected,
             count(*) FILTER (
               WHERE status = 'rejected' AND reject_reason = 'amount_mismatch'
                 AND paid_at >= now() - ${WINDOW} AND NOT is_test
             )::int AS mismatch,
             count(*) FILTER (
               WHERE status = 'refunded' AND refunded_at >= now() - ${WINDOW} AND NOT is_test
             )::int AS refunded,
             count(*) FILTER (
               WHERE ((status = 'paid' AND processed = false)
                  OR (status = 'rejected'
                      AND reject_reason IN ('invoice_invalidated', 'user_deleted')
                      AND refunded_at IS NULL))
                 AND NOT is_test
             )::int AS pending,
             count(*) FILTER (
               WHERE is_test AND paid_at >= now() - ${WINDOW}
             )::int AS test
           FROM payments`,
        ),
        this.db.queryOne<{ failed: number }>(
          // Только разборы: у совместимости своя цифра (`compat_failed_30d`).
          `SELECT count(*)::int AS failed
             FROM reports
            WHERE status = 'failed' AND kind = 'report'
              AND updated_at >= now() - ${WINDOW}`,
        ),
        this.db.queryOne<{ cost: string }>(
          `SELECT COALESCE(SUM(llm_cost_rub), 0)::text AS cost
             FROM reports
            WHERE created_at >= now() - ${WINDOW}`,
        ),
        // Серия провалов валидации — та же логика, что у брейкера в заказе.
        this.db.query<ReportHistoryRow>(
          `SELECT error_code, updated_at
             FROM reports
            WHERE kind = 'report'
            ORDER BY created_at DESC
            LIMIT 20`,
        ),
        // Совместимость: готовые и провалившиеся за 30 дней + остаток прав.
        this.db.queryOne<{ ready: number; failed: number; credits: number }>(
          `SELECT
             count(*) FILTER (WHERE status = 'ready')::int AS ready,
             count(*) FILTER (WHERE status = 'failed')::int AS failed,
             (
               (SELECT count(*) FROM entitlements
                 WHERE kind = 'compat' AND status = 'active' AND used_at IS NULL
                   AND (expires_at IS NULL OR expires_at > now()))
               +
               (SELECT count(*) FROM subscriptions s
                 WHERE s.status = 'active' AND s.expires_at > now()
                   AND NOT EXISTS (
                         SELECT 1 FROM reports r2
                          WHERE r2.user_id = s.user_id AND r2.kind = 'compat'
                            AND r2.status = 'ready'
                            AND COALESCE(r2.finished_at, r2.updated_at)
                                >= GREATEST(s.created_at, now() - interval '30 days')
                       ))
             )::int AS credits
           FROM reports
          WHERE kind = 'compat' AND created_at >= now() - ${WINDOW}`,
        ),
        // Свой счётчик брейкера: только `kind = 'compat'`.
        this.db.query<ReportHistoryRow>(
          `SELECT error_code, updated_at
             FROM reports
            WHERE kind = 'compat'
            ORDER BY created_at DESC
            LIMIT 20`,
        ),
        // Задача A: «повторяется в фоне» без числа — это «неизвестно, работает
        // ли». Первое — сколько отмен автопродления не прошло, второе —
        // сколько подписок всё ещё ждут повтора.
        this.db.queryOne<{ failed: number; pending: number }>(
          `SELECT
             (SELECT count(*)::int FROM events
               WHERE name = 'subscription_cancel_failed'
                 AND created_at >= now() - ${WINDOW}) AS failed,
             (SELECT count(*)::int FROM subscriptions
               WHERE status = 'cancelled'
                 AND telegram_cancel_state = 'failed') AS pending`,
        ),
      ]);

    const eventsByName: Record<string, number> = {};
    for (const row of events) {
      eventsByName[row.name] = row.total;
    }

    // Нулевые шаги тоже отдаём: клиенту проще рисовать воронку без «дыр».
    const funnelByStep: Record<string, number> = {};
    for (const step of FUNNEL_STEPS) {
      funnelByStep[step] = funnel.find((row) => row.name === step)?.users ?? 0;
    }

    const paying = subscriptions?.paying ?? 0;
    const mau = activity?.mau ?? 0;

    const series = validationStreak(history);
    const breaker = breakerState(series.streak, series.lastFailedAt);
    // `reports_validation_streak` — наблюдение и растёт всегда, даже при
    // выключенном брейкере. А `reports_breaker_open` отвечает на вопрос
    // «закрыт ли приём прямо сейчас»: при `REPORT_BREAKER_ENABLED=0` он
    // закрыт не бывает, что бы ни показывала серия.
    const closed = this.env.REPORT_BREAKER_ENABLED === '1' && breaker.open;

    const compatSeries = validationStreak(compatHistory);
    const compatBreaker = breakerState(compatSeries.streak, compatSeries.lastFailedAt);
    const compatClosed = this.env.COMPAT_BREAKER_ENABLED === '1' && compatBreaker.open;

    return {
      mau,
      paying,
      conversion_to_paid: ratio(paying, mau),
      // Оценка: доля отписок среди всех подписок, а не когортный churn —
      // для когорт нужна история, которую начнём копить с этой версии.
      churn_30d: ratio(subscriptions?.churned_30d ?? 0, subscriptions?.base ?? 0),
      stars_received_30d: payments?.stars ?? 0,
      // Одна формула: рубли по цене модели (QA-002, задача 2).
      llm_cost_rub_30d: Math.round(Number(cost?.cost ?? 0) * 10_000) / 10_000,
      reports_failed_30d: reports?.failed ?? 0,
      reports_validation_streak: breaker.streak,
      reports_breaker_open: closed,
      reports_breaker_last_failed_at: breaker.last_failed_at,
      payments_rejected_30d: payments?.rejected ?? 0,
      amount_mismatch_30d: payments?.mismatch ?? 0,
      refunded_30d: payments?.refunded ?? 0,
      pending_payments_now: payments?.pending ?? 0,
      subscription_cancel_failed_30d: telegramCancel?.failed ?? 0,
      subscriptions_cancelled_pending_telegram: telegramCancel?.pending ?? 0,
      test_payments_30d: payments?.test ?? 0,
      // Не из БД: это окружение процесса, поэтому метрика честна в ту же
      // секунду, когда флаг включили или сняли, — без ожидания платежа.
      test_plans_active: this.env.PAYMENTS_TEST_PLANS === '1',
      events_30d: eventsByName,
      funnel_30d: funnelByStep,
      compat_ready_30d: compat?.ready ?? 0,
      compat_failed_30d: compat?.failed ?? 0,
      compat_credits_left: compat?.credits ?? 0,
      compat_validation_streak: compatBreaker.streak,
      compat_breaker_open: compatClosed,
    };
  }
}
