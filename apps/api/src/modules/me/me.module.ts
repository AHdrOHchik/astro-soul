import { Module } from '@nestjs/common';
import { BillingModule } from '../billing/billing.module';
import { PlansModule } from '../billing/plans.module';
import { AccessService } from '../entitlements/access.service';
import { EntitlementsService } from '../entitlements/entitlements.service';
import { EventsModule } from '../events/events.module';
import { GrantsModule } from '../grants/grants.module';
import { FilesModule } from '../files/files.module';
import { PdfModule } from '../pdf/pdf.module';
import { QuotasService } from '../quotas/quotas.service';
import { TelegramModule } from '../telegram/telegram.module';
import { UsersRepository } from '../users/users.repository';
import { MeController } from './me.controller';
import { MeService } from './me.service';

@Module({
  // `TelegramModule` нужен только за состоянием inline-режима (`share.inline`
  // в `GET /me`, контракт 1.6.10). Цикла нет: `TelegramModule` про `me` не
  // знает и не импортирует `BillingModule`.
  imports: [
    BillingModule,
    EventsModule,
    PlansModule,
    PdfModule,
    FilesModule,
    TelegramModule,
    // Ссылка приглашения и активация кода из `start` (1.6.14). Цикла нет:
    // `GrantsModule` про `me` не знает.
    GrantsModule,
  ],
  controllers: [MeController],
  // `AccessService` — ради `Me.report_access` (1.6.19): право на разбор обязано
  // считаться той же дверью, что заказ и биллинг, иначе `/me` и `POST /reports`
  // снова разойдутся.
  providers: [MeService, UsersRepository, EntitlementsService, QuotasService, AccessService],
})
export class MeModule {}
