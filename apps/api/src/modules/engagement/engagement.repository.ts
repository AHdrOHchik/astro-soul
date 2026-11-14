import { Inject, Injectable } from '@nestjs/common';
import type { Chart } from '@astro-soul/shared';
import { DbService } from '../../db/db.service';

/** Карта в объёме, нужном ночному джобу. */
export interface ForecastCandidate {
  readonly chart_id: string;
  readonly user_id: string;
  readonly tz: string;
  /** Подписка действует: прогноз полный, иначе урезанный. */
  readonly paid: boolean;
  /** Данные карты: нужны сериализатору фактов. */
  readonly data: { readonly chart: Chart };
}

/** Карта с готовым прогнозом, ожидающим пуша. */
export interface PushCandidate {
  readonly forecast_id: string;
  readonly chart_id: string;
  readonly user_id: string;
  readonly tz: string;
  readonly is_paid: boolean;
  readonly text: string | null;
  readonly telegram_id: string | null;
}

export interface NewForecast {
  readonly chartId: string;
  readonly date: string;
  readonly teaser: string;
  readonly fullText: string | null;
  readonly focus: string | null;
  readonly isPaid: boolean;
  readonly costRub: number;
  readonly tokensIn: number;
  readonly tokensOut: number;
}

export interface AskRecord {
  readonly userId: string;
  readonly chartId: string;
  readonly questionLength: number;
  readonly topic: string;
  readonly answer: string;
  readonly basis: readonly string[];
  readonly costRub: number;
  readonly tokensIn: number;
  readonly tokensOut: number;
}

/** Ограничение пакета: ночной джоб не должен идти дольше разумного. */
export const FORECAST_BATCH = 200;
export const PUSH_BATCH = 200;

/**
 * Запросы удержания. Время везде передаётся параметром (`$at`), а не берётся
 * из `now()`: тесты и QA могут поставить «сейчас 03:00 по Москве», не
 * подменяя системные часы.
 */
@Injectable()
export class EngagementRepository {
  constructor(@Inject(DbService) private readonly db: DbService) {}

  /** Пояс карты — из `birth.place.tz`; пустая строка/мусор отсекаются в SQL. */
  private static readonly TZ_EXPR = `(c.data -> 'chart' -> 'birth' -> 'place' ->> 'tz')`;

  /** Минуты от местной полуночи для карты. */
  private static readonly LOCAL_MINUTES = `(EXTRACT(HOUR FROM ($1::timestamptz AT TIME ZONE ${EngagementRepository.TZ_EXPR})) * 60
        + EXTRACT(MINUTE FROM ($1::timestamptz AT TIME ZONE ${EngagementRepository.TZ_EXPR})))`;

  /** Местная дата карты. */
  private static readonly LOCAL_DATE = `($1::timestamptz AT TIME ZONE ${EngagementRepository.TZ_EXPR})::date`;

  /**
   * Карты, у которых местное время попало в окно `hour ± 30 мин` и на
   * местную дату ещё нет прогноза.
   *
   * Подписка — полный прогноз на каждый день. Бесплатные — не больше одного
   * в сутки на карту (гарантирует уникальный индекс) и только если карта
   * создана больше суток назад: иначе джоб сгенерирует прогноз всем, кто
   * зашёл один раз и ушёл.
   */
  async forecastCandidates(
    at: Date,
    windowStart: number,
    windowEnd: number,
    limit = FORECAST_BATCH,
  ): Promise<ForecastCandidate[]> {
    const rows = await this.db.query<ForecastCandidate>(
      `SELECT c.id AS chart_id,
              c.user_id,
              ${EngagementRepository.TZ_EXPR} AS tz,
              c.data,
              EXISTS (
                SELECT 1 FROM subscriptions s
                 WHERE s.user_id = c.user_id
                   AND s.status = 'active'
                   AND s.expires_at > $1::timestamptz
              ) AS paid
         FROM charts c
        WHERE ${EngagementRepository.TZ_EXPR} ~ '^[A-Za-z][A-Za-z0-9_+/-]*$'
          AND ${EngagementRepository.LOCAL_MINUTES} BETWEEN $2 AND $3
          AND NOT EXISTS (
                SELECT 1 FROM forecasts f
                 WHERE f.chart_id = c.id
                   AND f.date = ${EngagementRepository.LOCAL_DATE}
              )
          AND (
                EXISTS (
                  SELECT 1 FROM subscriptions s2
                   WHERE s2.user_id = c.user_id
                     AND s2.status = 'active'
                     AND s2.expires_at > $1::timestamptz
                )
                OR c.created_at < $1::timestamptz - interval '1 day'
              )
        ORDER BY c.created_at
        LIMIT $4`,
      [at, windowStart, windowEnd, limit],
    );

    return rows;
  }

  /** Идемпотентная вставка прогноза: повторный запуск не дублирует строку. */
  async insertForecast(input: NewForecast): Promise<string | null> {
    const row = await this.db.queryOne<{ id: string }>(
      `INSERT INTO forecasts (
         chart_id, date, teaser, full_text, focus, is_paid,
         llm_cost_rub, llm_tokens_in, llm_tokens_out
       ) VALUES ($1, $2::date, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (chart_id, date) DO NOTHING
       RETURNING id`,
      [
        input.chartId,
        input.date,
        input.teaser,
        input.fullText,
        input.focus,
        input.isPaid,
        input.costRub,
        input.tokensIn,
        input.tokensOut,
      ],
    );
    return row?.id ?? null;
  }

  async chartForUser(chartId: string, userId: string): Promise<{ id: string; data: { chart: Chart } } | null> {
    return this.db.queryOne<{ id: string; data: { chart: Chart } }>(
      `SELECT id, data FROM charts WHERE id = $1 AND user_id = $2`,
      [chartId, userId],
    );
  }

  /** Прогноз на конкретную местную дату. Читается как есть, без генерации. */
  async forecastFor(chartId: string, date: string): Promise<{
    id: string;
    date: string;
    teaser: string | null;
    full_text: string | null;
    focus: string | null;
    is_paid: boolean;
    created_at: Date;
  } | null> {
    return this.db.queryOne(
      `SELECT id, date::text AS date, teaser, full_text, focus, is_paid, created_at
         FROM forecasts
        WHERE chart_id = $1 AND date = $2::date`,
      [chartId, date],
    );
  }

  /**
   * Прогнозы на сегодня, которые ещё не пушили, где местное время 08:00 ±30,
   * а пользователь заходил за последние 7 дней. Заблокировавшие бота карты
   * и пользователи без `telegram_id` не выбираются вовсе.
   */
  async pushCandidates(
    at: Date,
    windowStart: number,
    windowEnd: number,
    limit = PUSH_BATCH,
  ): Promise<PushCandidate[]> {
    const rows = await this.db.query<{
      forecast_id: string;
      chart_id: string;
      user_id: string;
      tz: string;
      is_paid: boolean;
      text: string | null;
      telegram_id: string | null;
    }>(
      `SELECT f.id AS forecast_id,
              c.id AS chart_id,
              c.user_id,
              ${EngagementRepository.TZ_EXPR} AS tz,
              f.is_paid,
              COALESCE(f.full_text, f.teaser) AS text,
              u.telegram_id::text AS telegram_id
         FROM forecasts f
         JOIN charts c ON c.id = f.chart_id
         JOIN users u ON u.id = c.user_id
        WHERE f.push_sent_at IS NULL
          AND c.push_blocked_at IS NULL
          AND u.telegram_id IS NOT NULL
          AND ${EngagementRepository.LOCAL_MINUTES} BETWEEN $2 AND $3
          AND ${EngagementRepository.LOCAL_DATE} = f.date
          AND COALESCE(
                (SELECT max(e.created_at) FROM events e WHERE e.user_id = c.user_id),
                u.created_at
              ) > $1::timestamptz - interval '7 days'
        ORDER BY f.created_at
        LIMIT $4`,
      [at, windowStart, windowEnd, limit],
    );

    return rows;
  }

  /**
   * Сколько пушей не отправили только потому, что человек не заходил 7 дней.
   * Считается отдельно: это счётчик, а не повод выбирать такие строки в пакет.
   */
  async countPushInactive(at: Date, windowStart: number, windowEnd: number): Promise<number> {
    const row = await this.db.queryOne<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM forecasts f
         JOIN charts c ON c.id = f.chart_id
         JOIN users u ON u.id = c.user_id
        WHERE f.push_sent_at IS NULL
          AND c.push_blocked_at IS NULL
          AND u.telegram_id IS NOT NULL
          AND ${EngagementRepository.LOCAL_MINUTES} BETWEEN $2 AND $3
          AND ${EngagementRepository.LOCAL_DATE} = f.date
          AND COALESCE(
                (SELECT max(e.created_at) FROM events e WHERE e.user_id = c.user_id),
                u.created_at
              ) <= $1::timestamptz - interval '7 days'`,
      [at, windowStart, windowEnd],
    );
    return Number(row?.count ?? '0');
  }

  /** Отметка «пуш отправлен»: второй раз за день не отправим. */
  async markPushSent(forecastId: string): Promise<void> {
    await this.db.query(`UPDATE forecasts SET push_sent_at = now() WHERE id = $1`, [forecastId]);
  }

  /** Bot API ответил 403: помечаем карту и больше не пишем ей. */
  async markPushBlocked(chartId: string): Promise<void> {
    await this.db.query(
      `UPDATE charts SET push_blocked_at = now() WHERE id = $1 AND push_blocked_at IS NULL`,
      [chartId],
    );
  }

  /** Стоимость LLM за месяц по удержанию: прогнозы + «спроси карту». */
  async monthEngagementCostRub(): Promise<number> {
    const row = await this.db.queryOne<{ sum: string }>(
      `SELECT (
         COALESCE((SELECT sum(llm_cost_rub) FROM forecasts
                    WHERE created_at >= date_trunc('month', now())), 0)
       + COALESCE((SELECT sum(llm_cost_rub) FROM asks
                    WHERE created_at >= date_trunc('month', now())), 0)
       )::text AS sum`,
    );
    return Number(row?.sum ?? 0);
  }

  /**
   * Вопрос сохраняется без текста: только длина и тема. Текст вопроса — ПДн
   * («у меня депрессия», «муж изменил»), поэтому в БД его нет вовсе.
   */
  async insertAsk(input: AskRecord): Promise<void> {
    await this.db.query(
      `INSERT INTO asks (
         user_id, chart_id, question_length, topic, answer, basis,
         llm_cost_rub, llm_tokens_in, llm_tokens_out
       ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9)`,
      [
        input.userId,
        input.chartId,
        input.questionLength,
        input.topic,
        input.answer,
        JSON.stringify(input.basis),
        input.costRub,
        input.tokensIn,
        input.tokensOut,
      ],
    );
  }
}
