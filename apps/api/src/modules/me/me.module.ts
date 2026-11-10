import { Module } from '@nestjs/common';
import { EntitlementsService } from '../entitlements/entitlements.service';
import { QuotasService } from '../quotas/quotas.service';
import { UsersRepository } from '../users/users.repository';
import { MeController } from './me.controller';
import { MeService } from './me.service';

@Module({
  controllers: [MeController],
  providers: [MeService, UsersRepository, EntitlementsService, QuotasService],
})
export class MeModule {}
