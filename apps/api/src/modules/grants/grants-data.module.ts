import { Module } from '@nestjs/common';
import { GrantsRepository } from './grants.repository';

/**
 * Данные грантов отдельным модулем — чтобы `EntitlementsService` мог читать
 * права, не завися от сервисов выдачи.
 *
 * Почему это не лишняя прослойка: `GrantsService` вызывает
 * `BonusBudgetService`, а тот считает бюджет по `grants`; если бы
 * `EntitlementsModule` импортировал `GrantsModule` целиком, получился бы цикл
 * (`grants → entitlements → grants`). Репозиторий без зависимостей разрывает
 * его на уровне DI, а не через `forwardRef`.
 */
@Module({
  providers: [GrantsRepository],
  exports: [GrantsRepository],
})
export class GrantsDataModule {}
