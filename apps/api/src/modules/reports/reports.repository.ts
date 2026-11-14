import { Inject, Injectable } from '@nestjs/common';
import type { Chart } from '@astro-soul/shared';
import { DbService } from '../../db/db.service';

/** Одна глава в `reports.chapters` — ровно то, что ждёт контракт в `sections`. */
export interface ReportChapter {
  readonly key: string;
  readonly title: string;
  readonly body_md: string;
  readonly order: number;
}

export interface ReportRow {
  readonly id: string;
  readonly chart_id: string;
  readonly user_id: string;
  readonly kind: string;
  readonly status: string;
  readonly chapters: ReportChapter[] | null;
  readonly llm_cost_rub: string;
  readonly error_code: string | null;
  readonly teaser: string | null;
  readonly model: string | null;
  readonly created_at: Date;
  readonly updated_at: Date;
  readonly refunded_at: Date | null;
}

export interface ChartRowForReport {
  readonly id: string;
  /**
   * В `charts.data` лежит ответ движка целиком (`AstroChartData`), а карта
   * контракта — в поле `chart`. Ошибка «читаю data.planets» здесь стоила бы
   * 500 на заказе, поэтому форма описана явно.
   */
  readonly data: { readonly chart: Chart };
  readonly time_known: boolean;
}

const COLUMNS = `id, chart_id, user_id, kind::text AS kind, status::text AS status, chapters,
  llm_cost_rub, error_code, teaser, model, created_at, updated_at, refunded_at`;

@Injectable()
export class ReportsRepository {
  constructor(@Inject(DbService) private readonly db: DbService) {}

  /** Карта пользователя: чужая карта для него не существует (404, не 403). */
  async chartForUser(chartId: string, userId: string): Promise<ChartRowForReport | null> {
    return this.db.queryOne<ChartRowForReport>(
      `SELECT id, data, time_known FROM charts WHERE id = $1 AND user_id = $2`,
      [chartId, userId],
    );
  }

  async findByIdempotencyKey(userId: string, key: string): Promise<ReportRow | null> {
    return this.db.queryOne<ReportRow>(
      `SELECT ${COLUMNS} FROM reports WHERE user_id = $1 AND idempotency_key = $2`,
      [userId, key],
    );
  }

  /**
   * Доступ к полному разбору **именно этой** карты.
   *
   * Покупка без `chart_id` не «прикрепляется» к первой карте: скрытая
   * привязка платного товара — сюрприз для пользователя. Такой платёж
   * (до 1.5.2) просто не открывает разбор; новые покупки `one_149` без
   * `chart_id` не создаются — это проверяет `/billing/invoice`.
   */
  async hasReportEntitlement(userId: string, chartId: string): Promise<boolean> {
    const row = await this.db.queryOne<{ id: string }>(
      `SELECT id FROM entitlements
        WHERE user_id = $1
          AND kind = 'report'
          AND status = 'active'
          AND (expires_at IS NULL OR expires_at > now())
          AND chart_id = $2
        LIMIT 1`,
      [userId, chartId],
    );
    return row !== null;
  }

  async byId(id: string): Promise<ReportRow | null> {
    return this.db.queryOne<ReportRow>(`SELECT ${COLUMNS} FROM reports WHERE id = $1`, [id]);
  }

  /** Последний разбор по карте любого статуса: повторный заказ не плодит дубли. */
  async latestForChart(chartId: string, kind: string): Promise<ReportRow | null> {
    return this.db.queryOne<ReportRow>(
      `SELECT ${COLUMNS} FROM reports
        WHERE chart_id = $1 AND kind = $2::report_kind
        ORDER BY created_at DESC
        LIMIT 1`,
      [chartId, kind],
    );
  }

  async findReadyForChart(chartId: string, kind: string): Promise<ReportRow | null> {
    return this.db.queryOne<ReportRow>(
      `SELECT ${COLUMNS} FROM reports WHERE chart_id = $1 AND kind = $2::report_kind AND status = 'ready'`,
      [chartId, kind],
    );
  }

  /**
   * Создаёт заказ. Уникальный индекс `(user_id, idempotency_key)` — последняя
   * линия обороны: три тапа по кнопке приходят одновременно, и проигравший
   * гонку получает уже созданный разбор, а не второй.
   */
  async create(input: {
    readonly chartId: string;
    readonly userId: string;
    readonly kind: string;
    readonly idempotencyKey: string;
    readonly chartHash: string;
    readonly model: string;
    readonly promptVersion: string;
    readonly structureVersion: string;
  }): Promise<ReportRow> {
    const inserted = await this.db.queryOne<ReportRow>(
      `INSERT INTO reports
         (chart_id, user_id, kind, status, idempotency_key, chart_hash, model, prompt_version,
          report_structure_version)
       VALUES ($1, $2, $3::report_kind, 'queued', $4, $5, $6, $7, $8)
       ON CONFLICT (user_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
       RETURNING ${COLUMNS}`,
      [
        input.chartId,
        input.userId,
        input.kind,
        input.idempotencyKey,
        input.chartHash,
        input.model,
        input.promptVersion,
        input.structureVersion,
      ],
    );

    if (inserted !== null) {
      return inserted;
    }

    const existing = await this.findByIdempotencyKey(input.userId, input.idempotencyKey);
    if (existing === null) {
      throw new Error('reports: конфликт ключа идемпотентности без второй строки');
    }
    return existing;
  }

  async start(id: string): Promise<void> {
    await this.db.query(
      `UPDATE reports SET status = 'planning', started_at = now(), updated_at = now() WHERE id = $1`,
      [id],
    );
  }

  async savePlan(id: string, plan: unknown): Promise<void> {
    await this.db.query(`UPDATE reports SET plan = $2::jsonb, updated_at = now() WHERE id = $1`, [
      id,
      JSON.stringify(plan),
    ]);
  }

  /** Сохраняет главы и прогресс целиком: `GET` во время генерации видит их сразу. */
  async saveProgress(input: {
    readonly id: string;
    readonly status: 'writing' | 'ready';
    readonly chapters: readonly ReportChapter[];
    readonly teaser: string | null;
    readonly digests?: readonly string[];
    readonly validation?: unknown;
    readonly sectionStatus?: unknown;
  }): Promise<void> {
    await this.db.query(
      `UPDATE reports
          SET status = $2::report_status,
              chapters = $3::jsonb,
              teaser = COALESCE($4, teaser),
              digests = COALESCE($5::jsonb, digests),
              validation = COALESCE($6::jsonb, validation),
              section_status = COALESCE($7::jsonb, section_status),
              updated_at = now(),
              finished_at = CASE WHEN $2 = 'ready' THEN now() ELSE finished_at END
        WHERE id = $1`,
      [
        input.id,
        input.status,
        JSON.stringify(input.chapters),
        input.teaser,
        input.digests === undefined ? null : JSON.stringify(input.digests),
        input.validation === undefined ? null : JSON.stringify(input.validation),
        input.sectionStatus === undefined ? null : JSON.stringify(input.sectionStatus),
      ],
    );
  }

  /** Стоимость копится по факту вызовов: деньги списаны, даже если глава не прошла. */
  async addCost(id: string, costRub: number, attempts: number): Promise<void> {
    await this.db.query(
      `UPDATE reports
          SET llm_cost_rub = llm_cost_rub + $2,
              attempts = attempts + $3,
              updated_at = now()
        WHERE id = $1`,
      [id, costRub, attempts],
    );
  }

  /** Диагностика неудачной попытки: главы не трогаем, статус не меняем. */
  async saveDiagnostics(
    id: string,
    sectionStatus: unknown,
    validation: unknown,
  ): Promise<void> {
    await this.db.query(
      `UPDATE reports SET section_status = $2::jsonb, validation = $3::jsonb, updated_at = now()
        WHERE id = $1`,
      [id, JSON.stringify(sectionStatus), JSON.stringify(validation)],
    );
  }

  async fail(id: string, errorCode: string): Promise<void> {
    await this.db.query(
      `UPDATE reports SET status = 'failed', error_code = $2, finished_at = now(), updated_at = now()
        WHERE id = $1 AND status IN ('queued', 'planning', 'writing')`,
      [id, errorCode],
    );
  }

  async owned(id: string, userId: string): Promise<ReportRow | null> {
    return this.db.queryOne<ReportRow>(
      `SELECT ${COLUMNS} FROM reports WHERE id = $1 AND user_id = $2`,
      [id, userId],
    );
  }

  /** Расход на LLM за текущий календарный месяц, рубли. */
  async monthCostRub(): Promise<number> {
    const row = await this.db.queryOne<{ sum: string }>(
      `SELECT COALESCE(SUM(llm_cost_rub), 0)::text AS sum
         FROM reports
        WHERE created_at >= date_trunc('month', now())`,
    );
    return Number(row?.sum ?? 0);
  }
}
