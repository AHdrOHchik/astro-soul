import { Controller, Get, HttpCode, Inject, Param, Post, Query } from '@nestjs/common';
import { CurrentAdmin, type AdminActor } from '../admin-auth/admin-actor';
import {
  AdminReportsService,
  type AdminReportPage,
  type AdminReportQuery,
  type AdminReportRegenerateResult,
} from './admin-reports.service';

/**
 * Разборы в панели (контракт 1.6.16).
 *
 * `GET /admin/reports` — лента с фильтрами `status`, `kind`, `user_id`,
 * `limit`; `POST /admin/reports/{id}/regenerate` — `202 {report_id,
 * state: "queued", attempts}`. Ответ `202`, а не `200`: разбор действительно
 * собирается в фоне, и панель должна опрашивать ленту, а не ждать.
 */
@Controller('admin/reports')
export class AdminReportsController {
  constructor(@Inject(AdminReportsService) private readonly reports: AdminReportsService) {}

  @Get()
  list(
    @CurrentAdmin() actor: AdminActor,
    @Query() query: AdminReportQuery,
  ): Promise<AdminReportPage> {
    return this.reports.list(actor, query);
  }

  @Post(':id/regenerate')
  @HttpCode(202)
  regenerate(
    @CurrentAdmin() actor: AdminActor,
    @Param('id') id: string,
  ): Promise<AdminReportRegenerateResult> {
    return this.reports.regenerate(actor, id);
  }
}
