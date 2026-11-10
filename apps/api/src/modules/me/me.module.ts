import { Module } from '@nestjs/common';
import { EntitlementsService } from '../entitlements/entitlements.service';
import { EventsModule } from '../events/events.module';
import { QuotasService } from '../quotas/quotas.service';
import { UsersRepository } from '../users/users.repository';
import { MeController } from './me.controller';
import { MeService } from './me.service';

@Module({
  imports: [EventsModule],
  controllers: [MeController],
  providers: [MeService, UsersRepository, EntitlementsService, QuotasService],
})
export class MeModule {}
