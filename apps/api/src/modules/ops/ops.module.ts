import { Module } from '@nestjs/common';
import { AdminAuditModule } from '../admin-audit/admin-audit.module';
import { AdminAuthModule } from '../admin-auth/admin-auth.module';
import { BillingModule } from '../billing/billing.module';
import { EngagementModule } from '../engagement/engagement.module';
import { EventsModule } from '../events/events.module';
import { GrantsModule } from '../grants/grants.module';
import { TelegramModule } from '../telegram/telegram.module';
import { AdminController } from './admin.controller';
import { AdminOpsController } from './admin-ops.controller';
import { AdminOpsService } from './admin-ops.service';
import { BackupService } from './backup.service';
import { AdminMetricsService } from './admin-metrics.service';
import { AlertsService } from './alerts.service';
import { JobsController } from './jobs.controller';
import { JobsService } from './jobs.service';
import { ProdGuardService } from './prod-guard.service';
import { PushSchedulerService } from './push-scheduler.service';

/**
 * Служебные маршруты: метрики для владельца и джобы для крона.
 * Доступа из мини-аппа у них нет — только admin id и секрет крона.
 */
@Module({
  // `GrantsModule` — ради админских маршрутов выдачи (1.6.14): `POST /admin/grants`,
  // `POST /admin/codes`, `GET /admin/codes`. Цикла нет: гранты про `ops` не знают.
  // `AdminAuthModule` — ради джоба уборки сессий панели, `AdminAuditModule` —
  // ради записи журнала из админских ручек и метрик аудита (1.6.15).
  imports: [
    BillingModule,
    EngagementModule,
    EventsModule,
    TelegramModule,
    GrantsModule,
    AdminAuthModule,
    AdminAuditModule,
  ],
  controllers: [AdminController, AdminOpsController, JobsController],
  providers: [
    AdminMetricsService,
    AlertsService,
    AdminOpsService,
    BackupService,
    JobsService,
    ProdGuardService,
    PushSchedulerService,
  ],
  // Прод-гард нужен `main.ts` до `listen`: он спрашивает провайдер у корневого
  // инжектора, а не создаёт его руками.
  exports: [ProdGuardService],
})
export class OpsModule {}
