import { Inject, Injectable } from '@nestjs/common';
import type { Chart } from '@astro-soul/shared';
import { DbService } from '../../db/db.service';
import { PUSH_SEEN_CUTOFF_MINUTES } from './local-time';

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

/** Получатель утреннего пуша (итерация 38): карта, пояс, телеграм и данные карты. */
export interface PushRecipient {
  readonly user_id: string;
  readonly chart_id: string;
  readonly telegram_id: string;
  readonly tz: string;
  /** Местные сутки получателя (`YYYY-MM-DD`) — ключ идемпотентности. */
  readonly local_date: string;
  /** Данные карты для `/forecast/facts`: без них пуш не соберётся. */
  readonly data: unknown;
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
   * Получатели утреннего пуша: у кого местное время попало в окно и на эти
   * местные сутки пуша ещё не было.
   *
   * Сознательно **не** фильтруем по активности за 7 дней (правило итерации 32
   * «пишем только тем, кто заходил» заменено другим: не мешать тому, кто уже
   * зашёл утром). Отдельно отсекаются:
   *   • `push_enabled = false` — отказ из кабинета или кнопкой в самом пуше;
   *   • `telegram_id IS NULL` — писать некуда;
   *   • мусорный/пустой пояс — 08:00 по местному не вычислить (`skipped_no_tz`);
   *   • строка `push_log` за эти же местные сутки — второй раз не пушим;
   *   • `last_seen_at` после 07:30 местного — человек уже в приложении.
   *
   * Курсор (`afterUserId`) — потому что получателей берём порциями: тянуть
   * тысячи карт с JSON сразу незачем. Порядок по `id` стабилен между
   * запросами, поэтому порция не «съезжает».
   */
  async pushRecipients(
    at: Date,
    windowStart: number,
    windowEnd: number,
    limit: number,
    afterUserId: string | null = null,
    seenCutoffMinutes: number = PUSH_SEEN_CUTOFF_MINUTES,
  ): Promise<PushRecipient[]> {
    const rows = await this.db.query<PushRecipient>(
      `SELECT u.id AS user_id,
              c.id AS chart_id,
              u.telegram_id::text AS telegram_id,
              ${EngagementRepository.TZ_EXPR} AS tz,
              ${EngagementRepository.LOCAL_DATE}::text AS local_date,
              c.data
         FROM users u
         JOIN LATERAL (
                SELECT * FROM charts c2
                 WHERE c2.user_id = u.id
                 ORDER BY c2.created_at DESC
                 LIMIT 1
              ) c ON true
        WHERE u.push_enabled
          AND u.telegram_id IS NOT NULL
          AND ${EngagementRepository.TZ_EXPR} ~ '^[A-Za-z][A-Za-z0-9_+/-]*$'
          AND ${EngagementRepository.LOCAL_MINUTES} BETWEEN $2 AND $3
          AND ($4::uuid IS NULL OR u.id > $4::uuid)
          AND NOT EXISTS (
                SELECT 1 FROM push_log p
                 WHERE p.user_id = u.id
                   AND p.local_date = ${EngagementRepository.LOCAL_DATE}
                   AND p.kind = 'daily_forecast'
              )
          -- «Уже зашёл утром»: те же местные сутки и время ≥ 07:30.
          AND NOT (
                u.last_seen_at IS NOT NULL
                AND (u.last_seen_at AT TIME ZONE ${EngagementRepository.TZ_EXPR})::date = ${EngagementRepository.LOCAL_DATE}
                AND (EXTRACT(HOUR FROM (u.last_seen_at AT TIME ZONE ${EngagementRepository.TZ_EXPR})) * 60
                     + EXTRACT(MINUTE FROM (u.last_seen_at AT TIME ZONE ${EngagementRepository.TZ_EXPR}))) >= $6
              )
        ORDER BY u.id
        LIMIT $5`,
      [at, windowStart, windowEnd, afterUserId, limit, seenCutoffMinutes],
    );

    return rows;
  }

  /**
   * Сколько людей в окне пропущено, потому что уже заходили утром.
   * Считается отдельным запросом: такие строки не должны попадать в пакет.
   */
  async countPushSeen(
    at: Date,
    windowStart: number,
    windowEnd: number,
    seenCutoffMinutes: number = PUSH_SEEN_CUTOFF_MINUTES,
  ): Promise<number> {
    const row = await this.db.queryOne<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM users u
         JOIN LATERAL (
                SELECT * FROM charts c2
                 WHERE c2.user_id = u.id
                 ORDER BY c2.created_at DESC
                 LIMIT 1
              ) c ON true
        WHERE u.push_enabled
          AND u.telegram_id IS NOT NULL
          AND ${EngagementRepository.TZ_EXPR} ~ '^[A-Za-z][A-Za-z0-9_+/-]*$'
          AND ${EngagementRepository.LOCAL_MINUTES} BETWEEN $2 AND $3
          AND u.last_seen_at IS NOT NULL
          AND (u.last_seen_at AT TIME ZONE ${EngagementRepository.TZ_EXPR})::date = ${EngagementRepository.LOCAL_DATE}
          AND (EXTRACT(HOUR FROM (u.last_seen_at AT TIME ZONE ${EngagementRepository.TZ_EXPR})) * 60
               + EXTRACT(MINUTE FROM (u.last_seen_at AT TIME ZONE ${EngagementRepository.TZ_EXPR}))) >= $4`,
      [at, windowStart, windowEnd, seenCutoffMinutes],
    );
    return Number(row?.count ?? '0');
  }

  /**
   * Сколько людей с согласием, телеграмом и картой мы **никогда** не сможем
   * пушить: у карты нет валидного пояса.
   *
   * Это состояние, а не поток: один и тот же человек попадёт в счётчик и
   * завтра, поэтому метрика `push_skipped_no_tz_24h` — «сколько сейчас
   * недостижимо», а не «сколько раз пропустили за сутки».
   */
  async countPushNoTz(): Promise<number> {
    const row = await this.db.queryOne<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM users u
         JOIN LATERAL (
                SELECT * FROM charts c2
                 WHERE c2.user_id = u.id
                 ORDER BY c2.created_at DESC
                 LIMIT 1
              ) c ON true
        WHERE u.push_enabled
          AND u.telegram_id IS NOT NULL
          AND NOT (${EngagementRepository.TZ_EXPR} ~ '^[A-Za-z][A-Za-z0-9_+/-]*$')`,
    );
    return Number(row?.count ?? '0');
  }

  /**
   * Занять «эти местные сутки» до отправки.
   *
   * `false` — строка уже была: второй запуск в ту же минуту (деплой, ретрай,
   * второй инстанс). Уникальность `(user_id, local_date, kind)` — единственная
   * защита от второго «доброе утро» в одном чате, поэтому проверка живёт в БД,
   * а не в коде: гонка двух процессов ловится здесь же.
   */
  async claimPush(
    userId: string,
    localDate: string,
    kind: string = 'daily_forecast',
  ): Promise<boolean> {
    const row = await this.db.queryOne<{ id: string }>(
      `INSERT INTO push_log (user_id, local_date, kind)
       VALUES ($1, $2::date, $3)
       ON CONFLICT (user_id, local_date, kind) DO NOTHING
       RETURNING id`,
      [userId, localDate, kind],
    );

    return row !== null;
  }

  /** Итог отправки: `null` — ушло, иначе текст ошибки Bot API для `push_log`. */
  async finishPush(
    userId: string,
    localDate: string,
    kind: string,
    error: string | null,
  ): Promise<void> {
    await this.db.query(
      `UPDATE push_log SET error = $4
        WHERE user_id = $1 AND local_date = $2::date AND kind = $3`,
      [userId, localDate, kind, error],
    );
  }

  /**
   * Отказ от пушей: 403/«chat not found» от Bot API.
   *
   * Событие `push_disabled` пишет сервис через `EventsRepository`: журнал
   * событий — не дело репозитория рассылки, и `request_id` у него появится
   * только в общем пути.
   */
  async disablePush(userId: string): Promise<void> {
    await this.db.query(`UPDATE users SET push_enabled = false WHERE id = $1`, [userId]);
  }

  /** Одна строка на цикл: `/health` и метрики читают её, а не память процесса. */
  async insertPushRun(input: {
    readonly candidates: number;
    readonly sent: number;
    readonly skippedSeen: number;
    readonly skippedNoTz: number;
    readonly duplicatePrevented: number;
    readonly blocked: number;
    readonly deferred: number;
    readonly failed: number;
    readonly ms: number;
  }): Promise<void> {
    await this.db.query(
      `INSERT INTO push_runs (
         candidates, sent, skipped_seen, skipped_no_tz, duplicate_prevented,
         blocked, deferred, failed, ms, finished_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())`,
      [
        input.candidates,
        input.sent,
        input.skippedSeen,
        input.skippedNoTz,
        input.duplicatePrevented,
        input.blocked,
        input.deferred,
        input.failed,
        input.ms,
      ],
    );
  }

  /** Суммы по циклам за сутки: счётчики пропусков и защит от дублей. */
  async pushRunTotals24h(): Promise<{
    skippedNoTz: number;
    skippedSeen: number;
    duplicatePrevented: number;
    runs: number;
    lastRunAt: Date | null;
    lastSentCount: number;
    lastMs: number;
  }> {
    const row = await this.db.queryOne<{
      skipped_no_tz: number;
      skipped_seen: number;
      duplicate_prevented: number;
      runs: number;
      last_run_at: Date | null;
      last_sent_count: number | null;
      last_ms: number | null;
    }>(
      `SELECT COALESCE(sum(skipped_no_tz), 0)::int AS skipped_no_tz,
              COALESCE(sum(skipped_seen), 0)::int AS skipped_seen,
              COALESCE(sum(duplicate_prevented), 0)::int AS duplicate_prevented,
              count(*)::int AS runs,
              max(started_at) AS last_run_at,
              (SELECT sent FROM push_runs ORDER BY started_at DESC LIMIT 1) AS last_sent_count,
              (SELECT ms FROM push_runs ORDER BY started_at DESC LIMIT 1) AS last_ms
         FROM push_runs
        WHERE started_at >= now() - interval '24 hours'`,
    );

    return {
      skippedNoTz: row?.skipped_no_tz ?? 0,
      skippedSeen: row?.skipped_seen ?? 0,
      duplicatePrevented: row?.duplicate_prevented ?? 0,
      runs: row?.runs ?? 0,
      lastRunAt: row?.last_run_at ?? null,
      lastSentCount: row?.last_sent_count ?? 0,
      lastMs: row?.last_ms ?? 0,
    };
  }

  /** Итоги `push_log` за сутки: сколько ушло и сколько сломалось. */
  async pushLogTotals24h(): Promise<{ sent: number; failed: number }> {
    const row = await this.db.queryOne<{ sent: number; failed: number }>(
      `SELECT count(*) FILTER (WHERE error IS NULL)::int AS sent,
              count(*) FILTER (
                WHERE error IS NOT NULL
                  AND error NOT IN ('blocked', 'chat_not_found')
              )::int AS failed
         FROM push_log
        WHERE sent_at >= now() - interval '24 hours'`,
    );

    return { sent: row?.sent ?? 0, failed: row?.failed ?? 0 };
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
