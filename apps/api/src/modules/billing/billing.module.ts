import { Module } from '@nestjs/common';
import { ChartsModule } from '../charts/charts.module';
import { AccessService } from '../entitlements/access.service';
import { EntitlementsService } from '../entitlements/entitlements.service';
import { EventsModule } from '../events/events.module';
import { GrantsDataModule } from '../grants/grants-data.module';
import { TelegramModule } from '../telegram/telegram.module';
import { UsersRepository } from '../users/users.repository';
import { BillingController } from './billing.controller';
import { BillingRepository } from './billing.repository';
import { BillingService } from './billing.service';
import { PaymentsService } from './payments.service';
import { PlansModule } from './plans.module';
import { SubscriptionCancelService } from './subscription-cancel.service';
import { SubscriptionController } from './subscription.controller';
import { TelegramWebhookController } from './webhook.controller';

@Module({
  imports: [ChartsModule, TelegramModule, EventsModule, PlansModule, GrantsDataModule],
  controllers: [BillingController, SubscriptionController, TelegramWebhookController],
  providers: [
    BillingService,
    BillingRepository,
    PaymentsService,
    SubscriptionCancelService,
    // Дверь доступа нужна биллингу, чтобы не продать то, что у человека уже
    // есть правом (1.6.18): см. `createInvoice`.
    AccessService,
    EntitlementsService,
    UsersRepository,
  ],
  exports: [PaymentsService, BillingService, SubscriptionCancelService, PlansModule],
})
export class BillingModule {}
