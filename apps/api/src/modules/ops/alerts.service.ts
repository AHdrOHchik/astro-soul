import { Inject, Injectable } from '@nestjs/common';
import { stat } from 'node:fs/promises';
import { DbService } from '../../db/db.service';
import { APP_ENV } from '../../config/env.module';
import type { AppEnv } from '../../config/env';
import { AdminMetricsService } from './admin-metrics.service';
import { TelegramWebhookService } from '../telegram/telegram-webhook.service';

/**
 * Алерты для внешнего мониторинга (итерация 36).
 *
 * Зачем. Все цифры уже были в `/admin/metrics`, но следил за ними человек:
 * «оплата не доходит» обнаруживалось по жалобе, а «бэкап перестал делаться» —
 * никогда. Здесь минимальный набор, который настраивается в любом uptime-сервисе
 * (по `id` и `fired`), и тот же набор отдаётся в `GET /admin/alerts`, чтобы не
 * ходить за каждым значением в метрики.
 *
 * **Ничего нового не хранится**: значения считаются из тех же таблиц и событий,
 * что и `/admin/metrics`, плюс время вебхука и файл-маркер бэкапа. `since` —
 * время первого превышения порога: для счётчиков и стоимости это момент, когда
 * накопленная сумма в окне перевалила порог (оконная функция), для вебхука —
 * время последней проверки, для бэкапа — «последний успех + порог».
 *
 * Уровни: `critical` — человек уже пострадал или пострадает без вмешательства
 * (оплата, вебхук, отмена подписки); `warning` — деньги или качество ухудшаются,
 * но ответ пользователю ещё нормальный (расход, провалы генераций, бэкап).
 */

/** Идентификаторы алертов. По ним настраиваются правила в мониторинге. */
export type AlertId =
  | 'payment_not_arriving'
  | 'telegram_webhook'
  | 'subscription_cancel_blocked'
  | 'llm_spend'
  | 'generations_failing'
  | 'backup_stale'
  | 'push_failed';

export type AlertLevel = 'critical' | 'warning';

export interface AlertEntry {
  readonly id: AlertId;
  readonly level: AlertLevel;
  /** Текущее значение метрики. `null` — значение неизвестно (например, не было проверки). */
  readonly value: number | null;
  readonly threshold: number;
  /** Время первого превышения порога. `null` — не превышен. */
  readonly since: string | null;
  /** Сработал ли алерт: `value` выше порога (или значение неизвестно там, где это само по себе плохо). */
  readonly fired: boolean;
}

export interface AlertsResponse {
  readonly alerts: readonly AlertEntry[];
  readonly checked_at: string;
}

/** Пороги — в одних единицах с `value` (штуки, минуты, рубли, часы). */
export const ALERT_THRESHOLDS = {
  /** Ни одного отказа и ни одной неудачной оплаты: даже одна — уже человек без доступа. */
  payment_not_arriving: 0,
  /** Вебхук не в порядке дольше 10 минут. */
  telegram_webhook: 10,
  /** Ни одной подписки, которую мы не смогли отменить. */
  subscription_cancel_blocked: 0,
  /** Расход LLM за сутки, ₽. Бюджет GigaChat неизвестен — берём заведомо высокий порог. */
  llm_spend: 500,
  /** Провалов генераций за сутки. */
  generations_failing: 5,
  /** Дамп не делался дольше 36 часов (при ежедневном расписании это один пропуск). */
  backup_stale: 36,
  /**
   * Провалов утреннего пуша за сутки (итерация 38).
   *
   * 20 — не «доля от базы»: при базе в сотни человек и одном цикле в сутки любая
   * ошибка повторится завтра, поэтому 20 отказов означают не «немного шума», а
   * «Bot API или наш текст сломан». `blocked`/`chat not found` не считаются:
   * люди блокируют бота, это норма, и такие чаты отключаются сами.
   */
  push_failed: 20,
} as const;

const HOUR_MS = 60 * 60 * 1000;

@Injectable()
export class AlertsService {
  constructor(
    @Inject(AdminMetricsService) private readonly metrics: AdminMetricsService,
    @Inject(TelegramWebhookService) private readonly webhook: TelegramWebhookService,
    @Inject(DbService) private readonly db: DbService,
    @Inject(APP_ENV) private readonly env: AppEnv,
  ) {}

  /** Текущие значения всех алертов и их состояние. */
  async list(now: Date = new Date()): Promise<AlertsResponse> {
    const [metrics, crossings, backupAge] = await Promise.all([
      this.metrics.getMetrics(),
      this.firstCrossings(),
      this.backupAgeHours(now),
    ]);

    const webhook = this.webhook.health();

    // Оплата: сумма двух независимых поломок. `pre_checkout_rejected` — мы сами
    // отказали (данные счёта), `payment_failed` — Telegram списал, а доступ не
    // выдан. Обе означают «человек нажал купить и не получил».
    const paymentValue = metrics.pre_checkout_rejected_24h + metrics.payment_failed_24h;

    // Вебхук: сколько минут он не в порядке. `ok` — ноль; не проверяли —
    // значение неизвестно, но это не «всё хорошо».
    const webhookCheckedAt = webhook.checkedAt === null ? null : new Date(webhook.checkedAt);
    const webhookMinutes =
      webhook.state === 'ok'
        ? 0
        : webhookCheckedAt === null
          ? null
          : Math.floor((now.getTime() - webhookCheckedAt.getTime()) / 60_000);

    const spendValue =
      metrics.forecast_cost_rub_24h + metrics.questions_cost_rub_24h + metrics.compat_cost_rub_24h;

    const failuresValue =
      metrics.compat_failed_24h +
      metrics.forecast_failed_24h +
      metrics.questions_failed_24h +
      metrics.pdf_failed_24h;

    // Провалы пуша — отдельный алерт: у рассылки своя причина поломки (Bot API,
    // текст, лимиты), и складывать её с генерациями значит скрыть обе.
    const pushFailuresValue = metrics.push_failed_24h;

    const backupStaleSince =
      backupAge === null
        ? null
        : new Date(
            now.getTime() - (backupAge - ALERT_THRESHOLDS.backup_stale) * HOUR_MS,
          ).toISOString();

    const alerts: AlertEntry[] = [
      {
        id: 'payment_not_arriving',
        level: 'critical',
        value: paymentValue,
        threshold: ALERT_THRESHOLDS.payment_not_arriving,
        since: crossings.payment,
        fired: paymentValue > ALERT_THRESHOLDS.payment_not_arriving,
      },
      {
        id: 'telegram_webhook',
        level: 'critical',
        value: webhookMinutes,
        threshold: ALERT_THRESHOLDS.telegram_webhook,
        since: webhook.state === 'ok' ? null : (webhook.checkedAt ?? null),
        fired:
          webhook.state !== 'ok' &&
          (webhookMinutes === null || webhookMinutes > ALERT_THRESHOLDS.telegram_webhook),
      },
      {
        id: 'subscription_cancel_blocked',
        level: 'critical',
        value: metrics.subscription_cancel_no_charge_id_24h,
        threshold: ALERT_THRESHOLDS.subscription_cancel_blocked,
        since: crossings.cancel,
        fired:
          metrics.subscription_cancel_no_charge_id_24h > ALERT_THRESHOLDS.subscription_cancel_blocked,
      },
      {
        id: 'llm_spend',
        level: 'warning',
        value: Math.round(spendValue * 10_000) / 10_000,
        threshold: ALERT_THRESHOLDS.llm_spend,
        since: crossings.spend,
        fired: spendValue > ALERT_THRESHOLDS.llm_spend,
      },
      {
        id: 'generations_failing',
        level: 'warning',
        value: failuresValue,
        threshold: ALERT_THRESHOLDS.generations_failing,
        since: crossings.failures,
        fired: failuresValue > ALERT_THRESHOLDS.generations_failing,
      },
      {
        id: 'push_failed',
        level: 'warning',
        value: pushFailuresValue,
        threshold: ALERT_THRESHOLDS.push_failed,
        since: crossings.push,
        fired: pushFailuresValue > ALERT_THRESHOLDS.push_failed,
      },
      {
        id: 'backup_stale',
        level: 'warning',
        value: backupAge === null ? null : Math.round(backupAge * 10) / 10,
        threshold: ALERT_THRESHOLDS.backup_stale,
        // `since` — момент, когда порог был пересечён: «последний успех + 36 ч».
        since: backupAge !== null && backupAge > ALERT_THRESHOLDS.backup_stale ? backupStaleSince : null,
        // «Маркера нет» = «мы не знаем, делаются ли бэкапы» — это не «всё хорошо».
        fired: backupAge === null || backupAge > ALERT_THRESHOLDS.backup_stale,
      },
    ];

    return { alerts, checked_at: now.toISOString() };
  }

  /**
   * Возраст последнего успешного дампа в часах.
   *
   * Источник — файл-маркер, который `scripts/db-dump.sh` переписывает **после**
   * успешной выгрузки (см. `docs/BACKUP.md`). `null` — маркера нет: либо бэкап
   * ни разу не прошёл, либо путь не настроен. Оба случая одинаково плохие, но
   * неразличимые снаружи, и это видно в `value: null`.
   */
  async backupAgeHours(now: Date): Promise<number | null> {
    const file = this.env.BACKUP_STATE_FILE;

    if (file === undefined) {
      return null;
    }

    try {
      const info = await stat(file);
      return (now.getTime() - info.mtimeMs) / HOUR_MS;
    } catch {
      return null;
    }
  }

  /**
   * Время первого превышения порога по каждому счётчику.
   *
   * Оконная функция по накопленной сумме: это и есть «когда стало плохо»,
   * а не «самая ранняя строка в окне». Истории превышений мы не храним —
   * пересчитываем по тем же данным, что и метрики.
   */
  private async firstCrossings(): Promise<{
    payment: string | null;
    cancel: string | null;
    spend: string | null;
    failures: string | null;
    push: string | null;
  }> {
    const row = await this.db.queryOne<{
      payment: Date | null;
      cancel: Date | null;
      spend: Date | null;
      failures: Date | null;
      push: Date | null;
    }>(
      `SELECT
         (SELECT min(x.t) FROM (
            SELECT t, sum(1) OVER (ORDER BY t) AS running FROM (
              SELECT COALESCE(occurred_at, created_at) AS t FROM events
               WHERE name = 'pre_checkout_rejected'
                 AND COALESCE(occurred_at, created_at) >= now() - interval '24 hours'
              UNION ALL
              SELECT paid_at FROM payments
               WHERE status = 'rejected' AND paid_at >= now() - interval '24 hours'
            ) AS u) AS x WHERE x.running > $1) AS payment,
         (SELECT min(x.t) FROM (
            SELECT t, sum(1) OVER (ORDER BY t) AS running FROM (
              SELECT created_at AS t FROM events
               WHERE name = 'subscription_cancel_failed'
                 AND props ->> 'code' = 'no_charge_id'
                 AND created_at >= now() - interval '24 hours'
            ) AS u) AS x WHERE x.running > $2) AS cancel,
         (SELECT min(x.t) FROM (
            SELECT t, sum(cost) OVER (ORDER BY t) AS running FROM (
              SELECT created_at AS t, cost_rub::numeric AS cost FROM daily_forecasts
               WHERE created_at >= now() - interval '24 hours'
              UNION ALL
              SELECT created_at, cost_rub::numeric FROM questions
               WHERE created_at >= now() - interval '24 hours'
              UNION ALL
              SELECT created_at, llm_cost_rub::numeric FROM reports
               WHERE kind = 'compat' AND created_at >= now() - interval '24 hours'
            ) AS u) AS x WHERE x.running > $3) AS spend,
         (SELECT min(x.t) FROM (
            SELECT t, sum(1) OVER (ORDER BY t) AS running FROM (
              SELECT updated_at AS t FROM reports
               WHERE kind = 'compat' AND status = 'failed'
                 AND updated_at >= now() - interval '24 hours'
              UNION ALL
              SELECT created_at FROM events
               WHERE name = 'forecast_failed'
                 AND created_at >= now() - interval '24 hours'
              UNION ALL
              SELECT created_at FROM questions
               WHERE status = 'failed' AND created_at >= now() - interval '24 hours'
              UNION ALL
              SELECT updated_at FROM report_pdfs
               WHERE status = 'failed' AND updated_at >= now() - interval '24 hours'
            ) AS u) AS x WHERE x.running > $4) AS failures,
         (SELECT min(x.t) FROM (
            SELECT t, sum(1) OVER (ORDER BY t) AS running FROM (
              SELECT sent_at AS t FROM push_log
               WHERE error IS NOT NULL
                 AND error NOT IN ('blocked', 'chat_not_found')
                 AND sent_at >= now() - interval '24 hours'
            ) AS u) AS x WHERE x.running > $5) AS push`,
      [
        ALERT_THRESHOLDS.payment_not_arriving,
        ALERT_THRESHOLDS.subscription_cancel_blocked,
        ALERT_THRESHOLDS.llm_spend,
        ALERT_THRESHOLDS.generations_failing,
        ALERT_THRESHOLDS.push_failed,
      ],
    );

    return {
      payment: row?.payment?.toISOString() ?? null,
      cancel: row?.cancel?.toISOString() ?? null,
      spend: row?.spend?.toISOString() ?? null,
      failures: row?.failures?.toISOString() ?? null,
      push: row?.push?.toISOString() ?? null,
    };
  }
}
