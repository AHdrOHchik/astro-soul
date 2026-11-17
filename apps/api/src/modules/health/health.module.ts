import { Module } from '@nestjs/common';
import { AstroModule } from '../astro/astro.module';
import { TelegramModule } from '../telegram/telegram.module';
import { HealthController } from './health.controller';

@Module({
  // Telegram — ради состояния вебхука: «оплата не проходит» должно быть видно
  // в `/health` (итерация 26), а не только в логах контейнера.
  imports: [AstroModule, TelegramModule],
  controllers: [HealthController],
})
export class HealthModule {}
