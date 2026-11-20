import { Module } from '@nestjs/common';
import { EventsModule } from '../events/events.module';
import { FilesModule } from '../files/files.module';
import { ShareModule } from '../share/share.module';
import { TelegramClient } from './telegram.client';
import { TelegramInlineService } from './telegram-inline.service';
import { TelegramStartService } from './telegram-start.service';
import { TelegramWebhookService } from './telegram-webhook.service';

/**
 * Telegram Bot API и обработчики апдейтов.
 *
 * `ShareModule` и `FilesModule` нужны обработчику `/start sh_<short_id>`:
 * карточку по ссылке бот собирает из БД и отдаёт ей свежую подпись. Цикла нет:
 * ни шеринг, ни хранилище про Telegram не знают.
 *
 * `TelegramInlineService` (1.6.9) отвечает на `inline_query` — без него
 * `switchInlineQuery` из мини-аппа не приводит к карточке в чате.
 */
@Module({
  imports: [EventsModule, FilesModule, ShareModule],
  providers: [
    TelegramClient,
    TelegramStartService,
    TelegramInlineService,
    TelegramWebhookService,
  ],
  exports: [
    TelegramClient,
    TelegramStartService,
    TelegramInlineService,
    TelegramWebhookService,
  ],
})
export class TelegramModule {}
