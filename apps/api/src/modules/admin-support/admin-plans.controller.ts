import { Body, Controller, Get, HttpCode, Inject, Param, Patch } from '@nestjs/common';
import { CurrentAdmin, type AdminActor } from '../admin-auth/admin-actor';
import {
  AdminPlansService,
  type AdminPlanHistoryEntry,
  type AdminPlanPage,
  type AdminPriceUpdateResult,
} from './admin-plans.service';

/**
 * Цены тарифов (контракт 1.6.16).
 *
 * Все три ручки — под общим админским гардом (`initData` владельца или cookie
 * `__Host-admin_session` + `X-Admin-CSRF` на `PATCH`); «это владелец» проверяет
 * сервис, как и в `ops.AdminController`. Формы существующих маршрутов не
 * меняются: это новые пути, а не правка старых.
 */
@Controller('admin/plans')
export class AdminPlansController {
  constructor(@Inject(AdminPlansService) private readonly plans: AdminPlansService) {}

  /** `GET /admin/plans` — все тарифы, включая неактивные и тестовые. */
  @Get()
  list(@CurrentAdmin() actor: AdminActor): Promise<AdminPlanPage> {
    return this.plans.list(actor);
  }

  /**
   * `PATCH /admin/plans/{code}` — сменить цену.
   *
   * Тело: `{price_stars, comment, base_version}`. Ответ `200 {plan,
   * effective_from}`; `409 price_changed` — версия устарела, `403
   * founder_plan_locked` — тариф основателей. `200` явно: Nest по умолчанию
   * ответил бы `201` на `PATCH`.
   */
  @Patch(':code')
  @HttpCode(200)
  update(
    @CurrentAdmin() actor: AdminActor,
    @Param('code') code: string,
    @Body() body: unknown,
  ): Promise<AdminPriceUpdateResult> {
    return this.plans.updatePrice(actor, code, body);
  }

  /** `GET /admin/plans/{code}/history` — история цены, новое сверху. */
  @Get(':code/history')
  history(
    @CurrentAdmin() actor: AdminActor,
    @Param('code') code: string,
  ): Promise<{ readonly items: readonly AdminPlanHistoryEntry[] }> {
    return this.plans.history(actor, code);
  }
}
