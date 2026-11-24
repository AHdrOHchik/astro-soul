import { Body, Controller, HttpCode, Inject, Param, Post } from '@nestjs/common';
import { CurrentAdmin, type AdminActor } from '../admin-auth/admin-actor';
import {
  AdminOpsService,
  type AlertAckResult,
  type BackupRunResult,
  type WebhookReinstallResult,
} from './admin-ops.service';

/**
 * Операторские ручки панели (контракт 1.6.17).
 *
 * Три действия, которых не хватало экрану «Эксплуатация» и кнопке «скрыть» у
 * алерта: запустить дамп, переустановить вебхук, подтвердить алерт. Все три —
 * `POST` (то есть с `X-Admin-CSRF`, как остальные изменяющие ручки панели) и все
 * три пишут аудит.
 *
 * `POST /admin/backup/run` отвечает `202`: бэкап действительно идёт в фоне, и
 * `200` означал бы «сделано» — а это неправда, пока нет файла-маркера.
 */
@Controller('admin')
export class AdminOpsController {
  constructor(@Inject(AdminOpsService) private readonly ops: AdminOpsService) {}

  @Post('backup/run')
  @HttpCode(202)
  backup(@CurrentAdmin() actor: AdminActor, @Body() body: unknown): Promise<BackupRunResult> {
    return this.ops.runBackup(actor, body);
  }

  @Post('telegram/webhook')
  @HttpCode(200)
  webhook(@CurrentAdmin() actor: AdminActor, @Body() body: unknown): Promise<WebhookReinstallResult> {
    return this.ops.reinstallWebhook(actor, body);
  }

  @Post('alerts/:id/ack')
  @HttpCode(200)
  ack(
    @CurrentAdmin() actor: AdminActor,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<AlertAckResult> {
    return this.ops.ackAlert(actor, id, body);
  }
}
