import { Module } from '@nestjs/common';
import { BillingModule } from '../billing/billing.module';
import { EventsModule } from '../events/events.module';
import { TelegramModule } from '../telegram/telegram.module';
import { AdminController } from './admin.controller';
import { AdminMetricsService } from './admin-metrics.service';
import { JobsController } from './jobs.controller';
import { JobsService } from './jobs.service';

/**
 * Служебные маршруты: метрики для владельца и джобы для крона.
 * Доступа из мини-аппа у них нет — только admin id и секрет крона.
 */
@Module({
  imports: [BillingModule, EventsModule, TelegramModule],
  controllers: [AdminController, JobsController],
  providers: [AdminMetricsService, JobsService],
})
export class OpsModule {}
