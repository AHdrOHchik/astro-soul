import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query } from '@nestjs/common';
import { CurrentAdmin, type AdminActor } from '../admin-auth/admin-actor';
import { parseAdminUserSearch, type AdminUserQuery } from './admin-support.dto';
import {
  AdminUsersService,
  type AdminBanResult,
  type AdminPushResult,
  type AdminRefundResult,
  type AdminUserCard,
  type AdminUserPage,
} from './admin-users.service';

/**
 * Пользователи в панели поддержки (контракт 1.6.16).
 *
 * Все ручки — под общим админским гардом (`initData` владельца или cookie
 * `__Host-admin_session` + `X-Admin-CSRF` на `POST`). Формы существующих
 * маршрутов не тронуты: это новые пути.
 */
@Controller('admin/users')
export class AdminUsersController {
  constructor(@Inject(AdminUsersService) private readonly users: AdminUsersService) {}

  /**
   * `GET /admin/users` — поиск ровно по одному фильтру:
   * `telegram_id` | `alias` | `q`. Два фильтра или ни одного — `422
   * invalid_search`. Ответ без ПДн: дата и место рождения только в карточке.
   */
  @Get()
  list(
    @CurrentAdmin() actor: AdminActor,
    @Query() query: AdminUserQuery,
  ): Promise<AdminUserPage> {
    return this.users.search(actor, parseAdminUserSearch(query));
  }

  /** `GET /admin/users/{id}` — карточка. Пишет `user.card_view` в аудит. */
  @Get(':id')
  card(@CurrentAdmin() actor: AdminActor, @Param('id') id: string): Promise<AdminUserCard> {
    return this.users.card(actor, id);
  }

  /**
   * `POST /admin/users/{id}/refund` — полный возврат по `charge_id`.
   *
   * Тело: `{charge_id, reason}`. Суммы в запросе нет: возврат всегда полный, и
   * попытка прислать `amount`/`stars` — `422 refund_amount_not_allowed`.
   */
  @Post(':id/refund')
  @HttpCode(200)
  refund(
    @CurrentAdmin() actor: AdminActor,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<AdminRefundResult> {
    return this.users.refund(actor, id, body);
  }

  /** `POST /admin/users/{id}/ban` — заблокировать или разблокировать доступ. */
  @Post(':id/ban')
  @HttpCode(200)
  ban(
    @CurrentAdmin() actor: AdminActor,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<AdminBanResult> {
    return this.users.ban(actor, id, body);
  }

  /**
   * `POST /admin/users/{id}/push` — тестовый пуш (`kind = 'test'`), без окна
   * 08:00 и без проверки `last_seen_at`; один на местные сутки.
   */
  @Post(':id/push')
  @HttpCode(200)
  push(@CurrentAdmin() actor: AdminActor, @Param('id') id: string): Promise<AdminPushResult> {
    return this.users.pushTest(actor, id);
  }
}
