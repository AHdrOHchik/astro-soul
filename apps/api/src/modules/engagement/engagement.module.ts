import { Module } from '@nestjs/common';
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
  imports: [EventsModule, LlmModule, TelegramModule, PlansModule],
  controllers: [EngagementController],
  providers: [EngagementService, EngagementRepository, EntitlementsService, QuotasService, UsersRepository],
  exports: [EngagementService],
})
export class EngagementModule {}
