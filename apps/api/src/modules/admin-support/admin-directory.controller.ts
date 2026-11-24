import { Controller, Get, Inject, Query } from '@nestjs/common';
import { CurrentAdmin, type AdminActor } from '../admin-auth/admin-actor';
import {
  AdminDirectoryService,
  type AdminFoundersPage,
  type AdminPageQuery,
  type AdminPartnersPage,
  type AdminPaymentQuery,
  type AdminPaymentsPage,
} from './admin-directory.service';

/**
 * Справочники панели (контракт 1.6.17).
 *
 * Три экрана, которые до этой итерации были заглушками: «Основатели»,
 * «Партнёры» и «Платежи». Все три — `GET` без тела и без мутаций, поэтому
 * `CSRF`-заголовок панели здесь не нужен (он требуется только на `POST`/
 * `PATCH`). Доступ — общий админский гард и проверка `ADMIN_TG_ID` в сервисе.
 */
@Controller('admin')
export class AdminDirectoryController {
  constructor(@Inject(AdminDirectoryService) private readonly directory: AdminDirectoryService) {}

  /** `GET /admin/founders?limit=50&cursor=` — места 1…50 по дате заявки. */
  @Get('founders')
  founders(
    @CurrentAdmin() actor: AdminActor,
    @Query() query: AdminPageQuery,
  ): Promise<AdminFoundersPage> {
    return this.directory.founders(actor, query);
  }

  /**
   * `GET /admin/partners` — агрегаты по `access_codes.partner_name`.
   *
   * Без `limit`: партнёров единицы, и «страница партнёров» была бы формой без
   * содержания. Идентификаторов в ответе нет — только суммы и счётчики.
   */
  @Get('partners')
  partners(@CurrentAdmin() actor: AdminActor): Promise<AdminPartnersPage> {
    return this.directory.partners(actor);
  }

  /**
   * `GET /admin/payments?charge_id=&user_id=&status=&limit=&cursor=` — поиск
   * платежа. Главный сценарий — `charge_id` из чека.
   */
  @Get('payments')
  payments(
    @CurrentAdmin() actor: AdminActor,
    @Query() query: AdminPaymentQuery,
  ): Promise<AdminPaymentsPage> {
    return this.directory.payments(actor, query);
  }
}
