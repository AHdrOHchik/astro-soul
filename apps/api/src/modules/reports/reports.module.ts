import { Module } from '@nestjs/common';
import { EntitlementsService } from '../entitlements/entitlements.service';
import { LlmModule } from '../llm/llm.module';
import { UsersRepository } from '../users/users.repository';
import { ReportsController } from './reports.controller';
import { ReportsRepository } from './reports.repository';
import { ReportsService } from './reports.service';

@Module({
  imports: [LlmModule],
  controllers: [ReportsController],
  providers: [ReportsService, ReportsRepository, UsersRepository, EntitlementsService],
  exports: [ReportsService, ReportsRepository],
})
export class ReportsModule {}
