import { Module } from '@nestjs/common';
import { AstroModule } from '../astro/astro.module';
import { AccessService } from '../entitlements/access.service';
import { EntitlementsService } from '../entitlements/entitlements.service';
import { GrantsDataModule } from '../grants/grants-data.module';
import { PlansModule } from '../billing/plans.module';
import { LlmModule } from '../llm/llm.module';
import { UsersRepository } from '../users/users.repository';
import { CompatController } from './compat.controller';
import { CompatRepository } from './compat.repository';
import { CompatService } from './compat.service';

/**
 * Модуль совместимости.
 *
 * `ReportsModule` сюда **не** импортируется: из разбора совместимости нужны
 * только `MAX_ATTEMPTS`, `breakerState`, `parseIdempotencyKey` и коды провала —
 * это чистые функции и константы, а импорт модуля потянул бы в граф весь
 * конвейер разбора вместе с его провайдерами. `AstroModule` даёт клиент
 * сайдкара.
 */
@Module({
  // `PlansModule` — ради `EntitlementsService`: он читает права плана из `plans`.
  imports: [LlmModule, AstroModule, GrantsDataModule, PlansModule],
  controllers: [CompatController],
  providers: [
    CompatService,
    CompatRepository,
    UsersRepository,
    EntitlementsService,
    AccessService,
  ],
  exports: [CompatService, CompatRepository],
})
export class CompatModule {}
