import { Controller, Get, Inject } from '@nestjs/common';
import { APP_ENV } from '../../config/env.module';
import type { AppEnv } from '../../config/env';
import { forbidden } from '../../common/api-error';
import { JsonLogger } from '../../common/logger';
import { CurrentUser } from '../auth/current-user.decorator';
import type { VerifiedInitData } from '../auth/init-data';
import { AdminMetricsService, type ProductMetrics } from './admin-metrics.service';

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
    @Inject(APP_ENV) private readonly env: AppEnv,
    @Inject(JsonLogger) private readonly logger: JsonLogger,
  ) {}

  @Get('metrics')
  async getMetrics(@CurrentUser() auth: VerifiedInitData): Promise<ProductMetrics> {
    const adminId = this.env.ADMIN_TG_ID;

    if (adminId === undefined || BigInt(adminId) !== auth.telegramUserId) {
      this.logger.warn('admin_metrics_forbidden', { reason: 'not_admin' });
      throw forbidden({ reason: 'admin_only' });
    }

    return this.metrics.getMetrics();
  }
}
