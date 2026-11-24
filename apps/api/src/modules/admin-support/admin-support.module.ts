import { Module } from '@nestjs/common';
import { AdminAuditModule } from '../admin-audit/admin-audit.module';
import { BillingModule } from '../billing/billing.module';
import { TelegramModule } from '../telegram/telegram.module';
import { ReportsModule } from '../reports/reports.module';
import { AdminDirectoryController } from './admin-directory.controller';
import { AdminDirectoryRepository } from './admin-directory.repository';
import { AdminDirectoryService } from './admin-directory.service';
import { AdminPlansController } from './admin-plans.controller';
import { AdminPlansRepository } from './admin-plans.repository';
import { AdminPlansService } from './admin-plans.service';
import { AdminReportsController } from './admin-reports.controller';
import { AdminReportsRepository } from './admin-reports.repository';
import { AdminReportsService } from './admin-reports.service';
import { AdminUsersController } from './admin-users.controller';
import { AdminUsersRepository } from './admin-users.repository';
import { AdminUsersService } from './admin-users.service';

/**
 * Панель поддержки и цен (итерация 41, контракт 1.6.16).
 *
 * Отдельный модуль, а не новые ручки в `ops.AdminController`: тот файл —
 * метрики и ручная выдача прав, и добавлять к нему девять маршрутов с ПДн
 * значило бы смешать «что происходит» с «что делать с человеком». Гард общий:
 * всё под `/api/v1/admin/*` проходит через `InitDataMiddleware`, а «это
 * владелец» проверяет сервис — как и в `ops`.
 *
 * `ReportsModule` — ради перезапуска разбора (`ReportsService.restart`),
 * `TelegramModule` — ради возврата и тестового пуша, `AdminAuditModule` — ради
 * журнала (запись в той же транзакции, что и изменение).
 */
@Module({
  imports: [AdminAuditModule, BillingModule, ReportsModule, TelegramModule],
  controllers: [
    AdminDirectoryController,
    AdminPlansController,
    AdminUsersController,
    AdminReportsController,
  ],
  providers: [
    AdminDirectoryRepository,
    AdminDirectoryService,
    AdminPlansRepository,
    AdminPlansService,
    AdminUsersRepository,
    AdminUsersService,
    AdminReportsRepository,
    AdminReportsService,
  ],
})
export class AdminSupportModule {}
