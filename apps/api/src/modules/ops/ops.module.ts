import { Module } from '@nestjs/common';
import { BillingModule } from '../billing/billing.module';
import { EngagementModule } from '../engagement/engagement.module';
import { EventsModule } from '../events/events.module';
import { TelegramModule } from '../telegram/telegram.module';
import { AdminController } from './admin.controller';
import { AdminMetricsService } from './admin-metrics.service';
import { AlertsService } from './alerts.service';
import { JobsController } from './jobs.controller';
import { JobsService } from './jobs.service';
import { ProdGuardService } from './prod-guard.service';

/**
 * Служебные маршруты: метрики для владельца и джобы для крона.
 * Доступа из мини-аппа у них нет — только admin id и секрет крона.
 */
@Module({
  imports: [BillingModule, EngagementModule, EventsModule, TelegramModule],
  controllers: [AdminController, JobsController],
  providers: [AdminMetricsService, AlertsService, JobsService, ProdGuardService],
  // Прод-гард нужен `main.ts` до `listen`: он спрашивает провайдер у корневого
  // инжектора, а не создаёт его руками.
  exports: [ProdGuardService],
})
export class OpsModule {}
