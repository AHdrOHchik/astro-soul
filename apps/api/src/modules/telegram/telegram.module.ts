import { Module } from '@nestjs/common';
import { TelegramClient } from './telegram.client';

@Module({
  providers: [TelegramClient],
  exports: [TelegramClient],
})
export class TelegramModule {}
