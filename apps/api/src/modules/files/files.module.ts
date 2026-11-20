import { Module } from '@nestjs/common';
import { EventsModule } from '../events/events.module';
import { PdfRepository } from '../pdf/pdf.repository';
import { FilesController } from './files.controller';
import { FileStorageService } from './file-storage.service';

/**
 * Приватное хранилище файлов и единственный публичный маршрут к ним.
 *
 * `PdfRepository` объявлен здесь провайдером, чтобы `GET /files` мог считать
 * скачивания: у модуля нет собственных таблиц, а тянуть `PdfModule` целиком
 * значило бы замкнуть импорт (`PdfModule` импортирует `FilesModule`).
 */
@Module({
  imports: [EventsModule],
  controllers: [FilesController],
  providers: [FileStorageService, PdfRepository],
  exports: [FileStorageService],
})
export class FilesModule {}
