import { Module } from '@nestjs/common';
import { AstroModule } from '../astro/astro.module';
import { GrantsDataModule } from '../grants/grants-data.module';
import { BonusBudgetService } from '../grants/bonus-budget.service';
import { TelegramModule } from '../telegram/telegram.module';
import { HealthController } from './health.controller';

@Module({
  // Telegram — ради состояния вебхука: «оплата не проходит» должно быть видно
  // в `/health` (итерация 26), а не только в логах контейнера.
  // `GrantsDataModule` — ради бюджета бесплатного доступа в `flags`
  // (итерация 39): `/health` остаётся публичным и без моделей, но обязан
  // показывать `bonus_budget {spent_rub, limit_rub, exhausted}`.
  imports: [AstroModule, TelegramModule, GrantsDataModule],
  controllers: [HealthController],
  providers: [BonusBudgetService],
})
export class HealthModule {}
