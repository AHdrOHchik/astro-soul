import { Module } from '@nestjs/common';
import { BillingModule } from '../billing/billing.module';
import { EngagementModule } from '../engagement/engagement.module';
import { EventsModule } from '../events/events.module';
import { GrantsModule } from '../grants/grants.module';
import { TelegramModule } from '../telegram/telegram.module';
import { AdminController } from './admin.controller';
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
  imports: [BillingModule, EngagementModule, EventsModule, TelegramModule, GrantsModule],
  controllers: [AdminController, JobsController],
  providers: [AdminMetricsService, AlertsService, JobsService, ProdGuardService, PushSchedulerService],
  // Прод-гард нужен `main.ts` до `listen`: он спрашивает провайдер у корневого
  // инжектора, а не создаёт его руками.
  exports: [ProdGuardService],
})
export class OpsModule {}
