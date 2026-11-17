import { Module } from '@nestjs/common';
import { TelegramClient } from './telegram.client';
import { TelegramStartService } from './telegram-start.service';
import { TelegramWebhookService } from './telegram-webhook.service';

@Module({
  providers: [TelegramClient, TelegramStartService, TelegramWebhookService],
  exports: [TelegramClient, TelegramStartService, TelegramWebhookService],
})
export class TelegramModule {}
