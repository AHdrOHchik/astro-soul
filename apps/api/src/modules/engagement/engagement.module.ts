import { Module } from '@nestjs/common';
import { AstroModule } from '../astro/astro.module';
import { PlansModule } from '../billing/plans.module';
import { EntitlementsService } from '../entitlements/entitlements.service';
import { EventsModule } from '../events/events.module';
import { LlmModule } from '../llm/llm.module';
import { QuotasService } from '../quotas/quotas.service';
import { TelegramModule } from '../telegram/telegram.module';
import { UsersRepository } from '../users/users.repository';
import { EngagementController } from './engagement.controller';
import { EngagementRepository } from './engagement.repository';
import { EngagementService } from './engagement.service';

@Module({
  imports: [AstroModule, EventsModule, LlmModule, TelegramModule, PlansModule],
  controllers: [EngagementController],
  providers: [EngagementService, EngagementRepository, EntitlementsService, QuotasService, UsersRepository],
  // Репозиторий экспортирован ради метрик пуша: `OpsModule` читает те же
  // счётчики, что пишет рассылка, а не переписывает SQL заново.
  exports: [EngagementService, EngagementRepository],
})
export class EngagementModule {}
