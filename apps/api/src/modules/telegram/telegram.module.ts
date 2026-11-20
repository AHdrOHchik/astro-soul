import { Module } from '@nestjs/common';
import { EventsModule } from '../events/events.module';
import { FilesModule } from '../files/files.module';
import { ShareModule } from '../share/share.module';
import { TelegramClient } from './telegram.client';
import { TelegramStartService } from './telegram-start.service';
import { TelegramWebhookService } from './telegram-webhook.service';

/**
 * Telegram Bot API и обработчики апдейтов.
 *
 * `ShareModule` и `FilesModule` нужны обработчику `/start sh_<short_id>`:
 * карточку по ссылке бот собирает из БД и отдаёт ей свежую подпись. Цикла нет:
 * ни шеринг, ни хранилище про Telegram не знают.
 */
@Module({
  imports: [EventsModule, FilesModule, ShareModule],
  providers: [TelegramClient, TelegramStartService, TelegramWebhookService],
  exports: [TelegramClient, TelegramStartService, TelegramWebhookService],
})
export class TelegramModule {}
