import { Module } from '@nestjs/common';
import { AccessService } from '../entitlements/access.service';
import { EntitlementsService } from '../entitlements/entitlements.service';
import { GrantsDataModule } from '../grants/grants-data.module';
import { FilesModule } from '../files/files.module';
import { LlmModule } from '../llm/llm.module';
import { PlansModule } from '../billing/plans.module';
import { UsersRepository } from '../users/users.repository';
import { ReportsController } from './reports.controller';
import { ReportsRepository } from './reports.repository';
import { ReportsService } from './reports.service';

@Module({
  imports: [LlmModule, PlansModule, FilesModule, GrantsDataModule],
  controllers: [ReportsController],
  providers: [
    ReportsService,
    ReportsRepository,
    UsersRepository,
    EntitlementsService,
    AccessService,
  ],
  // `AccessService`/`EntitlementsService` нужны PDF: право на документ — это
  // право на разбор, и спрашивать его должен тот же сервис, что и маршруты.
  exports: [ReportsService, ReportsRepository, EntitlementsService, AccessService],
})
export class ReportsModule {}
