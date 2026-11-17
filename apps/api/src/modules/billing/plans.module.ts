import { Module } from '@nestjs/common';
import { PlansRepository } from './plans.repository';

/**
 * Резолвер цен отдельным модулем.
 *
 * `PlansRepository` нужен и биллингу, и `EntitlementsService` (права подписки
 * теперь тоже читаются из `plans`), а тот живёт сразу в трёх модулях —
 * `BillingModule`, `MeModule` и `EngagementModule`. Отдельный модуль избавляет
 * от цикла «MeModule → BillingModule → …» и оставляет один экземпляр репозитория.
 */
@Module({
  providers: [PlansRepository],
  exports: [PlansRepository],
})
export class PlansModule {}
