import { Module } from '@nestjs/common';
import { EntitlementsService } from '../entitlements/entitlements.service';
import { PlansModule } from '../billing/plans.module';
import { UsersRepository } from '../users/users.repository';
import { AccessCodesService } from './access-codes.service';
import { BonusBudgetService } from './bonus-budget.service';
import { CodeActivationThrottle } from './code-activation-throttle.service';
import { FoundersController, MeGrantsController } from './grants.controller';
import { GrantsService } from './grants.service';
import { GrantsDataModule } from './grants-data.module';
import { FoundersService } from './founders.service';
import { ReferralsService } from './referrals.service';

/**
 * Бесплатный доступ по праву (итерация 39).
 *
 * Провайдеры перечислены явно, как и в остальных модулях проекта: общего
 * «модуля-склада» здесь нет намеренно — список зависимостей модуля и есть его
 * документация.
 */
@Module({
  // `PlansModule` нужен `EntitlementsService`: права по коду выдаются в тех же
  // терминах, что и подписка (`plans.grants`), а `/me/activate-code` отдаёт
  // полный блок `Me.entitlements`. Цикла нет: планы про гранты не знают.
  imports: [GrantsDataModule, PlansModule],
  controllers: [MeGrantsController, FoundersController],
  providers: [
    GrantsService,
    AccessCodesService,
    FoundersService,
    ReferralsService,
    BonusBudgetService,
    CodeActivationThrottle,
    EntitlementsService,
    UsersRepository,
  ],
  exports: [
    GrantsService,
    AccessCodesService,
    FoundersService,
    ReferralsService,
    BonusBudgetService,
    GrantsDataModule,
  ],
})
export class GrantsModule {}
