import { Module } from '@nestjs/common';
import { ChartsModule } from '../charts/charts.module';
import { EntitlementsService } from '../entitlements/entitlements.service';
import { EventsModule } from '../events/events.module';
import { TelegramModule } from '../telegram/telegram.module';
import { UsersRepository } from '../users/users.repository';
import { BillingController } from './billing.controller';
import { BillingRepository } from './billing.repository';
import { BillingService } from './billing.service';
import { PaymentsService } from './payments.service';
import { TelegramWebhookController } from './webhook.controller';

@Module({
  imports: [ChartsModule, TelegramModule, EventsModule],
  controllers: [BillingController, TelegramWebhookController],
  providers: [
    BillingService,
    BillingRepository,
    PaymentsService,
    EntitlementsService,
    UsersRepository,
  ],
  exports: [PaymentsService, BillingService],
})
export class BillingModule {}
