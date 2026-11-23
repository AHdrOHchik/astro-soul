import { Module } from '@nestjs/common';
import { EventsModule } from '../events/events.module';
import { GrantsModule } from '../grants/grants.module';
import { UsersRepository } from '../users/users.repository';
import { FilesModule } from '../files/files.module';
import { ShareModule } from '../share/share.module';
import { TelegramClient } from './telegram.client';
import { TelegramInlineService } from './telegram-inline.service';
import { TelegramStartService } from './telegram-start.service';
import { TelegramWebhookService } from './telegram-webhook.service';
import { PushCallbackService } from './push-callback.service';

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
  // `GrantsModule` — обработчики `pt_` и `ref_` в `/start` (1.6.14): бот
  // активирует партнёрский код и запоминает приглашение до появления карты.
  imports: [EventsModule, FilesModule, ShareModule, GrantsModule],
  providers: [
    TelegramClient,
    TelegramStartService,
    TelegramInlineService,
    TelegramWebhookService,
    // `UsersRepository` — только ради псевдонима: отказ по кнопке пишет в то
    // же поле `users.push_enabled`, что кабинет.
    UsersRepository,
    PushCallbackService,
  ],
  exports: [
    TelegramClient,
    TelegramStartService,
    TelegramInlineService,
    TelegramWebhookService,
    PushCallbackService,
  ],
})
export class TelegramModule {}
