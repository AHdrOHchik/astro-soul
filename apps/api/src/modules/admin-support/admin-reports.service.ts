import { Inject, Injectable } from '@nestjs/common';
import { conflict, notFound, reasonOptions, validationFailed } from '../../common/api-error';
import { JsonLogger } from '../../common/logger';
import { DbService } from '../../db/db.service';
import { APP_ENV } from '../../config/env.module';
import type { AppEnv } from '../../config/env';
import { AdminAuditService } from '../admin-audit/admin-audit.service';
import { assertAdmin, type AdminActor } from '../admin-auth/admin-actor';
import { ReportsService } from '../reports/reports.service';
import { isUuid } from './admin-support.dto';
import { AdminReportsRepository, type AdminReportRow } from './admin-reports.repository';

export interface AdminReportSummary {
  readonly id: string;
  readonly user_id: string;
  readonly chart_id: string;
  readonly kind: string;
  readonly status: string;
  readonly error_code: string | null;
  readonly attempts: number;
  readonly cost_rub: number;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface AdminReportPage {
  readonly items: readonly AdminReportSummary[];
  readonly truncated: boolean;
}

export interface AdminReportRegenerateResult {
  readonly report_id: string;
  readonly state: 'queued';
  /** Сколько попыток генерации у разбора уже было; лимит `MAX_ATTEMPTS` не меняется. */
  readonly attempts: number;
}

const STATUSES = ['queued', 'planning', 'writing', 'ready', 'failed', 'refunded'] as const;
const KINDS = ['report', 'compat', 'solar'] as const;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

export interface AdminReportQuery {
  readonly status?: unknown;
  readonly kind?: unknown;
  readonly user_id?: unknown;
  readonly limit?: unknown;
}

/**
 * Разборы в панели (контракт 1.6.16).
 *
 * Перезапуск упавшего разбора — единственная мутация. Правила:
 *   • перезапускается **только** `failed`: `409 report_not_regenerable` иначе,
 *     иначе панель могла бы «перезапустить» готовый разбор и затереть текст;
 *   • новых платежей нет — это повтор уже оплаченной работы;
 *   • `MAX_ATTEMPTS` и `attempts` не трогаются: лимит попыток — часть генерации,
 *     а не рычаг поддержки;
 *   • аудит пишется в той же транзакции, что и постановка в очередь.
 */
@Injectable()
export class AdminReportsService {
  constructor(
    @Inject(AdminReportsRepository) private readonly repo: AdminReportsRepository,
    @Inject(ReportsService) private readonly reports: ReportsService,
    @Inject(AdminAuditService) private readonly audit: AdminAuditService,
    @Inject(DbService) private readonly db: DbService,
    @Inject(APP_ENV) private readonly env: AppEnv,
    @Inject(JsonLogger) private readonly logger: JsonLogger,
  ) {}

  async list(actor: AdminActor, query: AdminReportQuery): Promise<AdminReportPage> {
    assertAdmin(actor, this.env.ADMIN_TG_ID);

    const status = this.readEnum(query.status, STATUSES, 'status');
    const kind = this.readEnum(query.kind, KINDS, 'kind');
    const userId = this.readUuid(query.user_id);
    const limit = this.readLimit(query.limit);

    const { rows, truncated } = await this.repo.list({ status, kind, userId, limit });

    return { items: rows.map((row) => this.toSummary(row)), truncated };
  }

  /** `POST /admin/reports/{id}/regenerate` — вернуть упавший разбор в очередь. */
  async regenerate(actor: AdminActor, id: string): Promise<AdminReportRegenerateResult> {
    assertAdmin(actor, this.env.ADMIN_TG_ID);

    if (!isUuid(id)) {
      throw notFound(reasonOptions('report_not_found', 'Такого разбора нет'));
    }

    const outcome = await this.db.withTransaction(async (client) => {
      const row = await this.repo.requeue(client, id);

      if (row === null || row === 'not_failed') {
        return row;
      }

      await this.audit.write(client, actor, {
        action: 'report.regenerate',
        entity: 'report',
        entityId: id,
        before: { status: 'failed' },
        after: { status: 'queued' },
        reason: 'перезапуск из панели',
      });

      return row;
    });

    if (outcome === null) {
      throw notFound(reasonOptions('report_not_found', 'Такого разбора нет'));
    }

    if (outcome === 'not_failed') {
      throw conflict(
        reasonOptions('report_not_regenerable', 'Перезапустить можно только упавший разбор'),
      );
    }

    this.logger.info('admin_report_requeued', { report_id: id, attempts: outcome.attempts });

    // Асинхронно: `202` не ждёт модели, как и заказ разбора человеком.
    this.reports.restart(id);

    return { report_id: id, state: 'queued', attempts: outcome.attempts };
  }

  private toSummary(row: AdminReportRow): AdminReportSummary {
    return {
      id: row.id,
      user_id: row.user_id,
      chart_id: row.chart_id,
      kind: row.kind,
      status: row.status,
      error_code: row.error_code,
      attempts: row.attempts,
      cost_rub: Math.round(Number(row.llm_cost_rub) * 10_000) / 10_000,
      created_at: row.created_at.toISOString(),
      updated_at: row.updated_at.toISOString(),
    };
  }

  private readEnum<T extends string>(
    value: unknown,
    allowed: readonly T[],
    field: string,
  ): T | null {
    if (value === undefined || value === '') {
      return null;
    }

    if (typeof value !== 'string' || !allowed.includes(value as T)) {
      throw validationFailed({
        message: `Одно из: ${allowed.join(', ')}`,
        details: { reason: 'invalid_filter', field_errors: [{ field, message: 'Недопустимое значение' }] },
      });
    }

    return value as T;
  }

  private readUuid(value: unknown): string | null {
    if (value === undefined || value === '') {
      return null;
    }

    const pattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (typeof value !== 'string' || !pattern.test(value)) {
      throw validationFailed({
        message: 'user_id — UUID',
        details: { reason: 'invalid_filter', field_errors: [{ field: 'user_id', message: 'UUID' }] },
      });
    }

    return value;
  }

  private readLimit(value: unknown): number {
    if (value === undefined || value === '') {
      return DEFAULT_LIMIT;
    }

    const limit = typeof value === 'string' ? Number(value) : Number.NaN;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
      throw validationFailed({
        message: `limit от 1 до ${MAX_LIMIT}`,
        details: { reason: 'invalid_limit', field_errors: [{ field: 'limit', message: 'От 1 до 100' }] },
      });
    }

    return limit;
  }
}
