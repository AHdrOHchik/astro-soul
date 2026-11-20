import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DbService } from '../../db/db.service';
import { validationStreak, type ReportHistoryRow } from '../reports/breaker';
import type { Relationship } from './compat.dto';

/** Один раздел совместимости — ровно то, что уходит в `sections` контракта. */
export interface CompatSection {
  readonly key: string;
  readonly title: string;
  readonly text: string;
  readonly order: number;
}

export interface CompatReportRow {
  readonly id: string;
  readonly chart_id: string;
  readonly user_id: string;
  readonly status: string;
  readonly sections: CompatSection[] | null;
  readonly error_code: string | null;
  readonly llm_cost_rub: string;
  readonly model: string | null;
  readonly prompt_version: string;
  readonly created_at: Date;
  readonly updated_at: Date;
  readonly finished_at: Date | null;
  readonly relationship: Relationship | null;
  readonly compat_facts: unknown;
  readonly validation: unknown;
  readonly normalization: unknown;
  readonly section_status: unknown;
  readonly credit_entitlement_id: string | null;
  readonly compat_partner_id: string | null;
}

/** Данные партнёра в объёме, нужном сайдкару. Свободного текста нет. */
export interface CompatPartnerInput {
  readonly relationship: Relationship;
  readonly birthDate: string;
  readonly birthTime: string | null;
  readonly cityId: string | null;
  readonly lat: number;
  readonly lon: number;
  readonly tz: string;
}

export interface CompatPartnerRow extends CompatPartnerInput {
  readonly id: string;
  readonly created_at: Date;
}

export interface SubscriptionRow {
  readonly plan: 'trial' | 'week' | 'month' | 'year';
  readonly created_at: Date;
  readonly expires_at: Date;
}

const COLUMNS = `r.id, r.chart_id, r.user_id, r.status::text AS status, r.chapters AS sections,
  r.error_code, r.llm_cost_rub, r.model, r.prompt_version, r.created_at, r.updated_at,
  r.finished_at, p.relationship, r.compat_facts, r.validation, r.normalization,
  r.section_status, r.credit_entitlement_id, r.compat_partner_id`;

/**
 * Запросы совместимости. Всё, что должно быть атомарным (проверка квоты и
 * создание заказа), принимает `PoolClient` первым аргументом: порядок
 * блокировок виден в одном месте, как в биллинге.
 */
@Injectable()
export class CompatRepository {
  constructor(@Inject(DbService) private readonly db: DbService) {}

  // --- карта владельца -----------------------------------------------------

  async chartForUser(chartId: string, userId: string): Promise<{ id: string; data: unknown } | null> {
    return this.db.queryOne<{ id: string; data: unknown }>(
      `SELECT id, data FROM charts WHERE id = $1 AND user_id = $2`,
      [chartId, userId],
    );
  }

  // --- партнёр -------------------------------------------------------------

  async createPartner(client: PoolClient, userId: string, input: CompatPartnerInput): Promise<string> {
    const row = await client.query<{ id: string }>(
      `INSERT INTO compat_partners
         (user_id, relationship, birth_date, birth_time, city_id, lat, lon, tz)
       VALUES ($1, $2, $3::date, $4::time, $5, $6, $7, $8)
       RETURNING id`,
      [
        userId,
        input.relationship,
        input.birthDate,
        input.birthTime,
        input.cityId,
        input.lat,
        input.lon,
        input.tz,
      ],
    );
    const id = row.rows[0]?.id;
    if (id === undefined) {
      throw new Error('compat: партнёр не создан');
    }
    return id;
  }

  async partner(id: string): Promise<CompatPartnerRow | null> {
    return this.db.queryOne<CompatPartnerRow>(
      `SELECT id, relationship, birth_date::text AS "birthDate", birth_time::text AS "birthTime",
              city_id AS "cityId", lat::float8 AS lat, lon::float8 AS lon, tz, created_at
         FROM compat_partners WHERE id = $1`,
      [id],
    );
  }

  // --- заказы --------------------------------------------------------------

  async findByIdempotencyKey(userId: string, key: string): Promise<CompatReportRow | null> {
    return this.db.queryOne<CompatReportRow>(
      `SELECT ${COLUMNS} FROM reports r
         LEFT JOIN compat_partners p ON p.id = r.compat_partner_id
        WHERE r.user_id = $1 AND r.idempotency_key = $2 AND r.kind = 'compat'`,
      [userId, key],
    );
  }

  /** Заказ в работе: совместимость в статусах `queued | planning | writing`. */
  async inFlight(client: PoolClient, userId: string): Promise<number> {
    const row = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM reports
        WHERE user_id = $1 AND kind = 'compat'
          AND status IN ('queued', 'planning', 'writing')`,
      [userId],
    );
    return Number(row.rows[0]?.count ?? '0');
  }

  /**
   * Неизрасходованная разовая покупка совместимости.
   *
   * `FOR UPDATE` — чтобы две одновременные попытки не увидели один и тот же
   * кредит свободным: вторая ждёт первую и видит уже заказанную совместимость
   * (`inFlight`).
   */
  async unusedPurchase(client: PoolClient, userId: string): Promise<{ id: string } | null> {
    const row = await client.query<{ id: string }>(
      `SELECT id FROM entitlements
        WHERE user_id = $1 AND kind = 'compat' AND status = 'active'
          AND used_at IS NULL AND (expires_at IS NULL OR expires_at > now())
        ORDER BY granted_at
        LIMIT 1
        FOR UPDATE`,
      [userId],
    );
    return row.rows[0] ?? null;
  }

  /** Есть ли вообще активная покупка совместимости (для 422 при повторной оплате). */
  async hasActivePurchase(userId: string): Promise<boolean> {
    const row = await this.db.queryOne<{ one: number }>(
      `SELECT 1 AS one FROM entitlements
        WHERE user_id = $1 AND kind = 'compat' AND status = 'active'
          AND used_at IS NULL AND (expires_at IS NULL OR expires_at > now())
        LIMIT 1`,
      [userId],
    );
    return row !== null;
  }

  async subscription(userId: string): Promise<SubscriptionRow | null> {
    return this.db.queryOne<SubscriptionRow>(
      `SELECT plan, created_at, expires_at FROM subscriptions
        WHERE user_id = $1 AND status = 'active' AND expires_at > now()`,
      [userId],
    );
  }

  /** Когда последняя готовая совместимость закончилась: вход скользящего окна. */
  async lastReadyAt(userId: string): Promise<Date | null> {
    const row = await this.db.queryOne<{ at: Date | null }>(
      `SELECT max(COALESCE(finished_at, updated_at)) AS at FROM reports
        WHERE user_id = $1 AND kind = 'compat' AND status = 'ready'`,
      [userId],
    );
    return row?.at ?? null;
  }

  /**
   * Создание заказа. `ON CONFLICT` по ключу идемпотентности: три тапа по
   * кнопке дают один заказ, а проигравший гонку получает уже созданный.
   */
  async createReport(
    client: PoolClient,
    input: {
      readonly chartId: string;
      readonly userId: string;
      readonly idempotencyKey: string;
      readonly model: string;
      readonly promptVersion: string;
      readonly structureVersion: string;
      readonly factsVersion: string;
      readonly partnerId: string;
      /** Разовый кредит, который будет списан при `ready` (резерв, не списание). */
      readonly creditEntitlementId: string | null;
    },
  ): Promise<CompatReportRow> {
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO reports
         (chart_id, user_id, kind, status, idempotency_key, model, prompt_version,
          report_structure_version, chart_facts_version, compat_partner_id,
          credit_entitlement_id)
       VALUES ($1, $2, 'compat', 'queued', $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (user_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
       RETURNING id`,
      [
        input.chartId,
        input.userId,
        input.idempotencyKey,
        input.model,
        input.promptVersion,
        input.structureVersion,
        input.factsVersion,
        input.partnerId,
        input.creditEntitlementId,
      ],
    );

    const id = inserted.rows[0]?.id;
    if (id !== undefined) {
      // Читаем той же транзакцией: `this.db` — отдельное соединение, и
      // незакоммиченная строка ему не видна (проверено тестом: 500 на
      // `заказ создан, но не читается`).
      const created = await client.query<CompatReportRow>(
        `SELECT ${COLUMNS} FROM reports r
           LEFT JOIN compat_partners p ON p.id = r.compat_partner_id
          WHERE r.id = $1 AND r.user_id = $2 AND r.kind = 'compat'`,
        [id, input.userId],
      );
      const row = created.rows[0];
      if (row !== undefined) {
        return row;
      }
      throw new Error('compat: заказ создан, но не читается');
    }

    const existing = await this.findByIdempotencyKey(input.userId, input.idempotencyKey);
    if (existing === null) {
      throw new Error('compat: конфликт ключа идемпотентности без второй строки');
    }
    return existing;
  }

  async owned(id: string, userId: string): Promise<CompatReportRow | null> {
    return this.db.queryOne<CompatReportRow>(
      `SELECT ${COLUMNS} FROM reports r
         LEFT JOIN compat_partners p ON p.id = r.compat_partner_id
        WHERE r.id = $1 AND r.user_id = $2 AND r.kind = 'compat'`,
      [id, userId],
    );
  }

  async byId(id: string): Promise<CompatReportRow | null> {
    return this.db.queryOne<CompatReportRow>(
      `SELECT ${COLUMNS} FROM reports r
         LEFT JOIN compat_partners p ON p.id = r.compat_partner_id
        WHERE r.id = $1 AND r.kind = 'compat'`,
      [id],
    );
  }

  /**
   * История совместимостей для человека (контракт 1.6.7).
   *
   * `ready` и незавершённые (`queued`/`planning`/`writing` → в ответе
   * `pending`) отдаются, `failed` и `refunded` — **никогда**. Решение
   * владельца: неудачная попытка — наша внутренняя история, а не товар; в
   * приложении она читается как «я заплатил и получил ошибку», даже когда
   * кредит не списан. По `id` такая запись по-прежнему доступна
   * (`GET /compatibility/{id}`): это нужно воркеру, QA и разбору инцидентов.
   *
   * Фильтр стоит в SQL **до** `LIMIT`: если появится пагинация или `total`,
   * они обязаны считаться от того же набора, иначе счётчик и список
   * разойдутся.
   */
  async listForUser(userId: string, limit = 20): Promise<CompatReportRow[]> {
    return this.db.query<CompatReportRow>(
      `SELECT ${COLUMNS} FROM reports r
         LEFT JOIN compat_partners p ON p.id = r.compat_partner_id
        WHERE r.user_id = $1 AND r.kind = 'compat'
          AND r.status NOT IN ('failed', 'refunded')
        ORDER BY r.created_at DESC
        LIMIT $2`,
      [userId, limit],
    );
  }

  async partnerInfo(reportId: string): Promise<CompatPartnerRow | null> {
    return this.db.queryOne<CompatPartnerRow>(
      `SELECT p.id, p.relationship, p.birth_date::text AS "birthDate",
              p.birth_time::text AS "birthTime", p.city_id AS "cityId",
              p.lat::float8 AS lat, p.lon::float8 AS lon, p.tz, p.created_at
         FROM compat_partners p
         JOIN reports r ON r.compat_partner_id = p.id
        WHERE r.id = $1`,
      [reportId],
    );
  }

  // --- ход сборки ----------------------------------------------------------

  async start(id: string): Promise<void> {
    await this.db.query(
      `UPDATE reports SET status = 'planning', started_at = now(), updated_at = now()
        WHERE id = $1 AND kind = 'compat'`,
      [id],
    );
  }

  async saveFacts(id: string, facts: unknown): Promise<void> {
    await this.db.query(
      `UPDATE reports SET compat_facts = $2::jsonb, updated_at = now() WHERE id = $1`,
      [id, JSON.stringify(facts)],
    );
  }

  async saveProgress(input: {
    readonly id: string;
    readonly status: 'writing' | 'ready';
    readonly sections: readonly CompatSection[];
    readonly validation?: unknown;
    readonly sectionStatus?: unknown;
    readonly normalization?: unknown;
  }): Promise<void> {
    await this.db.query(
      `UPDATE reports
          SET status = $2::report_status,
              chapters = $3::jsonb,
              validation = COALESCE($4::jsonb, validation),
              section_status = COALESCE($5::jsonb, section_status),
              normalization = COALESCE($6::jsonb, normalization),
              updated_at = now(),
              finished_at = CASE WHEN $2 = 'ready' THEN now() ELSE finished_at END
        WHERE id = $1 AND kind = 'compat'`,
      [
        input.id,
        input.status,
        JSON.stringify(input.sections),
        input.validation === undefined ? null : JSON.stringify(input.validation),
        input.sectionStatus === undefined ? null : JSON.stringify(input.sectionStatus),
        input.normalization === undefined ? null : JSON.stringify(input.normalization),
      ],
    );
  }

  async addCost(
    id: string,
    usage: { readonly costRub: number; readonly promptTokens: number; readonly completionTokens: number },
    attempts: number,
  ): Promise<void> {
    await this.db.query(
      `UPDATE reports
          SET llm_cost_rub = llm_cost_rub + $2,
              llm_tokens_in = llm_tokens_in + $3,
              llm_tokens_out = llm_tokens_out + $4,
              attempts = attempts + $5,
              updated_at = now()
        WHERE id = $1`,
      [id, usage.costRub, usage.promptTokens, usage.completionTokens, attempts],
    );
  }

  async fail(id: string, errorCode: string, diagnostics: { validation: unknown; sectionStatus: unknown; normalization: unknown }): Promise<void> {
    await this.db.query(
      `UPDATE reports
          SET status = 'failed', error_code = $2, finished_at = now(), updated_at = now(),
              validation = $3::jsonb, section_status = $4::jsonb, normalization = $5::jsonb
        WHERE id = $1 AND kind = 'compat' AND status IN ('queued', 'planning', 'writing')`,
      [
        id,
        errorCode,
        JSON.stringify(diagnostics.validation),
        JSON.stringify(diagnostics.sectionStatus),
        JSON.stringify(diagnostics.normalization),
      ],
    );
  }

  /**
   * Списание разового кредита — **только** при `ready` и в одной транзакции с
   * записью статуса. Провал сюда не доходит, поэтому «возврат кредита» — это
   * отсутствие списания, а не отдельная операция: джобы и ручного сброса нет.
   */
  async consumePurchase(client: PoolClient, entitlementId: string, reportId: string): Promise<void> {
    await client.query(
      `UPDATE entitlements SET used_at = now()
        WHERE id = $1 AND used_at IS NULL`,
      [entitlementId],
    );
    await client.query(
      `UPDATE reports SET credit_entitlement_id = $2 WHERE id = $1`,
      [reportId, entitlementId],
    );
  }

  // --- брейкер и метрики ---------------------------------------------------

  /** Серия провалов валидации **только** по совместимостям. */
  async validationStreak(limit = 20): Promise<{ streak: number; lastFailedAt: Date | null }> {
    const rows = await this.db.query<ReportHistoryRow>(
      `SELECT error_code, updated_at FROM reports
        WHERE kind = 'compat'
        ORDER BY created_at DESC
        LIMIT $1`,
      [limit],
    );
    return validationStreak(rows);
  }

  /** Расход на LLM по совместимостям за календарный месяц — для месячного капа. */
  async monthCostRub(): Promise<number> {
    const row = await this.db.queryOne<{ sum: string | null }>(
      `SELECT COALESCE(sum(llm_cost_rub), 0)::text AS sum FROM reports
        WHERE kind = 'compat' AND created_at >= date_trunc('month', now())`,
    );
    return Number(row?.sum ?? '0');
  }

  async counts30d(): Promise<{ ready: number; failed: number }> {
    const row = await this.db.queryOne<{ ready: string; failed: string }>(
      `SELECT
         count(*) FILTER (WHERE status = 'ready')::text AS ready,
         count(*) FILTER (WHERE status = 'failed')::text AS failed
         FROM reports
        WHERE kind = 'compat' AND created_at > now() - interval '30 days'`,
    );
    return { ready: Number(row?.ready ?? '0'), failed: Number(row?.failed ?? '0') };
  }

  /** Сколько совместимостей пользователи могут получить прямо сейчас. */
  async creditsLeft(now: Date = new Date()): Promise<number> {
    const purchases = await this.db.queryOne<{ count: string }>(
      `SELECT count(*)::text AS count FROM entitlements
        WHERE kind = 'compat' AND status = 'active' AND used_at IS NULL
          AND (expires_at IS NULL OR expires_at > now())`,
    );

    // Подписка даёт одну совместимость в 30 дней; «осталось» — те активные
    // подписки, у которых в текущем окне ещё ничего не собрано.
    const subscriptions = await this.db.queryOne<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM subscriptions s
        WHERE s.status = 'active' AND s.expires_at > now()
          AND NOT EXISTS (
                SELECT 1 FROM reports r
                 WHERE r.user_id = s.user_id AND r.kind = 'compat' AND r.status = 'ready'
                   AND COALESCE(r.finished_at, r.updated_at) >=
                       GREATEST(s.created_at, $1::timestamptz - interval '30 days')
              )`,
      [now],
    );

    return Number(purchases?.count ?? '0') + Number(subscriptions?.count ?? '0');
  }
}
