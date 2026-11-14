import { Inject, Injectable } from '@nestjs/common';
import { DbService } from '../../db/db.service';

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
  readonly llm_cost_usd_30d: number;
  readonly reports_failed_30d: number;
  /** QA-11: платежи, по которым доступ не выдан. */
  readonly payments_rejected_30d: number;
  readonly amount_mismatch_30d: number;
  readonly refunded_30d: number;
  readonly pending_payments_now: number;
  readonly events_30d: Readonly<Record<string, number>>;
  readonly funnel_30d: Readonly<Record<string, number>>;
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
  constructor(@Inject(DbService) private readonly db: DbService) {}

  async getMetrics(): Promise<ProductMetrics> {
    const [activity, events, funnel, subscriptions, payments, reports] = await Promise.all([
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
        `SELECT
           count(*) FILTER (WHERE status = 'active' AND expires_at > now())::int AS paying,
           count(*) FILTER (
             WHERE status IN ('expired', 'cancelled') AND updated_at >= now() - ${WINDOW}
           )::int AS churned_30d,
           count(*)::int AS base
         FROM subscriptions`,
      ),
      this.db.queryOne<{
        stars: number;
        rejected: number;
        mismatch: number;
        refunded: number;
        pending: number;
      }>(
        // `rejected` — деньги не за доступ: в выручку не попадают (QA-11).
        `SELECT
           COALESCE(sum(total_amount) FILTER (
             WHERE status NOT IN ('refunded', 'rejected') AND paid_at >= now() - ${WINDOW}
           ), 0)::int AS stars,
           count(*) FILTER (
             WHERE status = 'rejected' AND paid_at >= now() - ${WINDOW}
           )::int AS rejected,
           count(*) FILTER (
             WHERE status = 'rejected' AND reject_reason = 'amount_mismatch'
               AND paid_at >= now() - ${WINDOW}
           )::int AS mismatch,
           count(*) FILTER (
             WHERE status = 'refunded' AND refunded_at >= now() - ${WINDOW}
           )::int AS refunded,
           count(*) FILTER (WHERE processed = false AND status = 'paid')::int AS pending
         FROM payments`,
      ),
      this.db.queryOne<{ failed: number }>(
        `SELECT count(*)::int AS failed
           FROM reports
          WHERE status = 'failed'
            AND updated_at >= now() - ${WINDOW}`,
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

    return {
      mau,
      paying,
      conversion_to_paid: ratio(paying, mau),
      // Оценка: доля отписок среди всех подписок, а не когортный churn —
      // для когорт нужна история, которую начнём копить с этой версии.
      churn_30d: ratio(subscriptions?.churned_30d ?? 0, subscriptions?.base ?? 0),
      stars_received_30d: payments?.stars ?? 0,
      // LLM ещё не подключён: стоимость пишется в `reports.llm_cost_usd`
      // в следующей итерации, до тех пор честный ноль.
      llm_cost_usd_30d: 0,
      reports_failed_30d: reports?.failed ?? 0,
      payments_rejected_30d: payments?.rejected ?? 0,
      amount_mismatch_30d: payments?.mismatch ?? 0,
      refunded_30d: payments?.refunded ?? 0,
      pending_payments_now: payments?.pending ?? 0,
      events_30d: eventsByName,
      funnel_30d: funnelByStep,
    };
  }
}
