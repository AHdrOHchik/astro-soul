import { Module } from '@nestjs/common';
import { AstroModule } from '../astro/astro.module';
import { EventsModule } from '../events/events.module';
import { FilesModule } from '../files/files.module';
import { ReportsModule } from '../reports/reports.module';
import { UsersRepository } from '../users/users.repository';
import { PdfController } from './pdf.controller';
import { PdfRepository } from './pdf.repository';
import { PdfService } from './pdf.service';

@Module({
  imports: [ReportsModule, AstroModule, EventsModule, FilesModule],
  controllers: [PdfController],
  providers: [PdfService, PdfRepository, UsersRepository],
  exports: [PdfService, PdfRepository],
})
export class PdfModule {}
