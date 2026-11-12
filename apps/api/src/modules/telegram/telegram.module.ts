import { Module } from '@nestjs/common';
import { TelegramClient } from './telegram.client';
import { TelegramStartService } from './telegram-start.service';

@Module({
  providers: [TelegramClient, TelegramStartService],
  exports: [TelegramClient, TelegramStartService],
})
export class TelegramModule {}
