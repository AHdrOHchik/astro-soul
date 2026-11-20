import { Module } from '@nestjs/common';
import { BillingModule } from '../billing/billing.module';
import { PlansModule } from '../billing/plans.module';
import { EntitlementsService } from '../entitlements/entitlements.service';
import { EventsModule } from '../events/events.module';
import { FilesModule } from '../files/files.module';
import { PdfModule } from '../pdf/pdf.module';
import { QuotasService } from '../quotas/quotas.service';
import { UsersRepository } from '../users/users.repository';
import { MeController } from './me.controller';
import { MeService } from './me.service';

@Module({
  imports: [BillingModule, EventsModule, PlansModule, PdfModule, FilesModule],
  controllers: [MeController],
  providers: [MeService, UsersRepository, EntitlementsService, QuotasService],
})
export class MeModule {}
