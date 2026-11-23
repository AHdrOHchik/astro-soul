import { Body, Controller, Get, HttpCode, Inject, Post, Query } from '@nestjs/common';
import { APP_ENV } from '../../config/env.module';
import type { AppEnv } from '../../config/env';
import { forbidden, invalidFields } from '../../common/api-error';
import { JsonLogger } from '../../common/logger';
import { CurrentUser } from '../auth/current-user.decorator';
import type { VerifiedInitData } from '../auth/init-data';
import { AccessCodesService, type AccessCodeRow } from '../grants/access-codes.service';
import { GrantsService } from '../grants/grants.service';

/** Строка админского списка прав: одна выдача, включая отозванные. */
interface AdminGrantView {
  readonly id: string;
  readonly user_id: string;
  readonly kind: string;
  readonly source: string;
  readonly code_id: string | null;
  readonly days: number | null;
  readonly starts_at: string | null;
  readonly expires_at: string | null;
  readonly consumed_at: string | null;
  readonly revoked_at: string | null;
  readonly revoked: boolean;
  readonly created_at: string;
}
import {
  parseAdminCodeCreate,
  parseAdminGrantCreate,
  type AdminGrantCreate,
} from '../grants/admin.dto';
import { AdminMetricsService, type ProductMetrics } from './admin-metrics.service';
import { AlertsService, type AlertsResponse } from './alerts.service';

/**
 * `GET /api/v1/admin/metrics` — метрики продукта для владельца.
 *
 * Доступ — по `ADMIN_TG_ID` из окружения, а не по роли в БД: одна переменная,
 * которую нельзя поменять из мини-аппа. ID не задан — маршрут закрыт всегда
 * (403), и это осознанно: «нет настройки» не должно означать «открыто всем».
 */
@Controller('admin')
export class AdminController {
  constructor(
    @Inject(AdminMetricsService) private readonly metrics: AdminMetricsService,
    @Inject(AlertsService) private readonly alerts: AlertsService,
    @Inject(APP_ENV) private readonly env: AppEnv,
    @Inject(JsonLogger) private readonly logger: JsonLogger,
    @Inject(GrantsService) private readonly grants: GrantsService,
    @Inject(AccessCodesService) private readonly codes: AccessCodesService,
  ) {}

  /** Общая проверка «это владелец»: та же, что у метрик, и те же 403. */
  private assertAdmin(auth: VerifiedInitData, action: string): void {
    const adminId = this.env.ADMIN_TG_ID;

    if (adminId === undefined || BigInt(adminId) !== auth.telegramUserId) {
      this.logger.warn('admin_action_forbidden', { action, reason: 'not_admin' });
      throw forbidden({ reason: 'admin_only' });
    }
  }

  /**
   * `POST /admin/grants` (1.6.14) — выдать или отозвать право вручную.
   *
   * Тело: `{user_id, kind, days?, action?: 'issue'|'revoke', grant_id?}`.
   * Отзыв не удаляет строку: `revoked_at` — это история выдачи, и «почему у
   * человека отобрали доступ» должно отвечаться запросом, а не восстановлением
   * из логов.
   */
  @Post('grants')
  @HttpCode(200)
  async issueGrant(
    @CurrentUser() auth: VerifiedInitData,
    @Body() body: unknown,
  ): Promise<{ grant_id: string; kind: string; source: string; expires_at: string | null }> {
    this.assertAdmin(auth, 'grant');

    const input: AdminGrantCreate = parseAdminGrantCreate(body);

    if (input.action === 'revoke') {
      const row = await this.grants.revoke(input.user_id, input.grant_id);
      return {
        grant_id: row.id,
        kind: row.kind,
        source: row.source,
        expires_at: row.expires_at?.toISOString() ?? null,
      };
    }

    const issued = await this.grants.issue({
      userId: input.user_id,
      kind: input.kind,
      source: 'admin',
      days: input.days,
    });

    return {
      grant_id: issued.grant.id,
      kind: issued.grant.kind,
      source: issued.grant.source,
      expires_at: issued.grant.expires_at?.toISOString() ?? null,
    };
  }

  /**
   * `GET /admin/grants?user_id=` (1.6.14) — история прав человека.
   *
   * Фильтр обязателен: «все права всех людей» — это выгрузка базы, а не
   * экран поддержки. Без `user_id` — `422`, чтобы клиент не решил, что
   * список пуст.
   */
  @Get('grants')
  async listGrants(
    @CurrentUser() auth: VerifiedInitData,
    @Query('user_id') userId: string | undefined,
  ): Promise<{ items: AdminGrantView[] }> {
    this.assertAdmin(auth, 'grant_list');

    if (userId === undefined || userId.trim() === '') {
      throw invalidFields([{ field: 'user_id', message: 'Укажи user_id' }]);
    }

    const rows = await this.grants.listForAdmin(userId);

    return {
      items: rows.map((row) => ({
        id: row.id,
        user_id: row.user_id,
        kind: row.kind,
        source: row.source,
        code_id: row.code_id,
        days: row.days,
        starts_at: row.starts_at?.toISOString() ?? null,
        expires_at: row.expires_at?.toISOString() ?? null,
        consumed_at: row.consumed_at?.toISOString() ?? null,
        revoked_at: row.revoked_at?.toISOString() ?? null,
        revoked: row.revoked_at !== null,
        created_at: row.created_at.toISOString(),
      })),
    };
  }

  /** `POST /admin/codes` (1.6.14) — создать код доступа. */
  @Post('codes')
  @HttpCode(201)
  async createCode(
    @CurrentUser() auth: VerifiedInitData,
    @Body() body: unknown,
  ): Promise<AccessCodeRow> {
    this.assertAdmin(auth, 'code_create');
    return this.codes.create(parseAdminCodeCreate(body));
  }

  /** `GET /admin/codes` (1.6.14) — последние коды с остатком активаций. */
  @Get('codes')
  async listCodes(@CurrentUser() auth: VerifiedInitData): Promise<{ items: AccessCodeRow[] }> {
    this.assertAdmin(auth, 'code_list');
    return { items: [...(await this.codes.list())] };
  }

  @Get('metrics')
  async getMetrics(@CurrentUser() auth: VerifiedInitData): Promise<ProductMetrics> {
    const adminId = this.env.ADMIN_TG_ID;

    if (adminId === undefined || BigInt(adminId) !== auth.telegramUserId) {
      this.logger.warn('admin_metrics_forbidden', { reason: 'not_admin' });
      throw forbidden({ reason: 'admin_only' });
    }

    return this.metrics.getMetrics();
  }

  /**
   * `GET /admin/alerts` (итерация 36) — то, что настраивается в мониторинге,
   * с текущими значениями. Отдельный маршрут, чтобы внешний uptime-чек не
   * выкачивал полсотни метрик ради шести чисел, и чтобы правило мониторинга
   * было одним запросом к одному `id`.
   */
  @Get('alerts')
  async getAlerts(@CurrentUser() auth: VerifiedInitData): Promise<AlertsResponse> {
    const adminId = this.env.ADMIN_TG_ID;

    if (adminId === undefined || BigInt(adminId) !== auth.telegramUserId) {
      this.logger.warn('admin_alerts_forbidden', { reason: 'not_admin' });
      throw forbidden({ reason: 'admin_only' });
    }

    return this.alerts.list();
  }
}
