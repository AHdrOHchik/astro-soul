import { Inject, Injectable } from '@nestjs/common';
import { ApiError, conflict, internalError, validationFailed } from '../../common/api-error';
import { JsonLogger } from '../../common/logger';
import { maskWebhookUrl } from '../../common/secret-url';
import { DbService } from '../../db/db.service';
import { APP_ENV } from '../../config/env.module';
import type { AppEnv } from '../../config/env';
import { AdminAuditService } from '../admin-audit/admin-audit.service';
import { assertAdmin, isAdmin, type AdminActor } from '../admin-auth/admin-actor';
import { TelegramWebhookService } from '../telegram/telegram-webhook.service';
import { ALERT_ACK_BOUNDS, parseAlertAck } from '../admin-support/admin-support.dto';
import { AlertsService, type AlertEntry, type AlertId } from './alerts.service';
import { BackupService } from './backup.service';
import { parseOpsReason } from './admin-ops.dto';

/** Ответ `POST /admin/backup/run` (202). */
export interface BackupRunResult {
  readonly started: true;
  readonly job_id: string;
}

/** Ответ `POST /admin/telegram/webhook`. */
export interface WebhookReinstallResult {
  readonly url: string;
  readonly ok: boolean;
  readonly last_error_message: string | null;
}

/** Ответ `POST /admin/alerts/{id}/ack`. */
export interface AlertAckResult {
  readonly acked_until: string;
  /** Состояние алерта сразу после подтверждения: `value`/`threshold` те же. */
  readonly alert: AlertEntry;
}

/**
 * Операторские действия панели (контракт 1.6.17): бэкап, вебхук, подтверждение
 * алерта.
 *
 * Все три меняют продакшн-состояние или мониторинг, поэтому:
 *   • ни одно не выполняется без `ADMIN_TG_ID` (как и остальные админские ручки);
 *   • каждое пишет аудит (`backup.run`, `webhook.reinstall`, `alert.ack`) — до
 *     ответа, в той же транзакции, что и изменение, где оно есть;
 *   • «не настроено» — это `503`/`409`, а не «сделалось»: панель обязана
 *     показать причину, иначе владелец будет ждать бэкап, которого не будет.
 */
@Injectable()
export class AdminOpsService {
  constructor(
    @Inject(BackupService) private readonly backup: BackupService,
    @Inject(TelegramWebhookService) private readonly webhook: TelegramWebhookService,
    @Inject(AlertsService) private readonly alerts: AlertsService,
    @Inject(AdminAuditService) private readonly audit: AdminAuditService,
    @Inject(DbService) private readonly db: DbService,
    @Inject(APP_ENV) private readonly env: AppEnv,
    @Inject(JsonLogger) private readonly logger: JsonLogger,
  ) {}

  /**
   * `POST /admin/backup/run` — запустить `scripts/db-dump.sh` из процесса.
   *
   * `202`, а не `200`: дамп идёт минуты, и ответ означает «запущено», а не
   * «сделано». Успех подтверждается файлом-маркером (`backup_stale` в алертах и
   * `value` в `GET /admin/alerts`), а не этим ответом — иначе кнопка врала бы
   * так же, как «бэкап без выгрузки».
   */
  async runBackup(actor: AdminActor, body: unknown): Promise<BackupRunResult> {
    this.ensureAdmin(actor, 'backup.run');

    const input = parseOpsReason(body);
    const outcome = this.backup.start();

    if (outcome.kind === 'not_configured') {
      this.logger.warn('admin_backup_not_configured', { missing: outcome.missing });

      throw new ApiError('UNAVAILABLE', 503, {
        reason: 'backup_not_configured',
        message: 'Выгрузка бэкапов не настроена — делать дамп некуда',
        details: { reason: 'backup_not_configured', missing: outcome.missing },
      });
    }

    if (outcome.kind === 'in_progress') {
      // `retry_after_seconds` — интервал опроса, не срок окончания: сколько
      // идти дампу, сервер не знает (см. `BACKUP_IN_PROGRESS_RETRY_SECONDS`).
      // Панель по нему говорит «повтори через N», а не «нельзя».
      throw conflict({
        reason: 'backup_in_progress',
        message: 'Дамп уже идёт',
        details: {
          reason: 'backup_in_progress',
          retry_after_seconds: outcome.retryAfterSeconds,
        },
      });
    }

    if (outcome.kind === 'too_frequent') {
      // Тот же `409 CONFLICT`: панели важно, что «сейчас нельзя», а различие
      // «уже идёт» / «был минуту назад» — в `details.reason`.
      throw conflict({
        reason: 'backup_too_frequent',
        message: 'Бэкап уже делали меньше 10 минут назад',
        details: {
          reason: 'backup_too_frequent',
          retry_after_seconds: outcome.retryAfterSeconds,
        },
      });
    }

    await this.db.withTransaction(async (client) => {
      await this.audit.write(client, actor, {
        action: 'backup.run',
        entity: 'backup',
        entityId: outcome.jobId,
        after: { job_id: outcome.jobId },
        reason: input.reason,
      });
    });

    this.logger.info('admin_backup_started', { job_id: outcome.jobId, reason: input.reason });

    return { started: true, job_id: outcome.jobId };
  }

  /**
   * `POST /admin/telegram/webhook` — переустановить вебхук на текущий адрес.
   *
   * Ответ Bot API отдаётся как есть (включая `last_error_message`): панель
   * показывает текст причины, а не «что-то пошло не так». `deleteWebhook` не
   * вызывается — см. `TelegramWebhookService.reinstall`.
   */
  async reinstallWebhook(actor: AdminActor, body: unknown): Promise<WebhookReinstallResult> {
    this.ensureAdmin(actor, 'webhook.reinstall');

    const input = parseOpsReason(body);
    const url = this.webhook.expectedUrl();

    if (url === null) {
      throw conflict({
        reason: 'webhook_url_not_configured',
        message: 'MINI_APP_URL или TELEGRAM_WEBHOOK_SECRET не заданы',
        details: { reason: 'webhook_url_not_configured' },
      });
    }

    const answer = await this.webhook.reinstall();

    await this.db.withTransaction(async (client) => {
      await this.audit.write(client, actor, {
        action: 'webhook.reinstall',
        entity: 'webhook',
        entityId: null,
        after: { url: maskWebhookUrl(url), ok: answer.ok, last_error_message: answer.lastErrorMessage },
        reason: input.reason,
      });
    });

    if (!answer.ok) {
      this.logger.error('admin_webhook_reinstall_failed', {
        url: maskWebhookUrl(url),
        last_error_message: answer.lastErrorMessage,
      });

      // 502 — Telegram/сеть, а не наша ошибка. Поля ответа Bot API кладём в
      // `details`: тело ошибки в этом API всегда `Problem` (контракт 1.5.10), и
      // ломать единый формат ради одной ручки — хуже, чем одно поле на уровень
      // глубже (см. отчёт итерации 43).
      throw internalError({
        status: 502,
        reason: 'telegram_webhook_failed',
        message: answer.lastErrorMessage ?? 'Telegram не подтвердил установку вебхука',
        details: {
          reason: 'telegram_webhook_failed',
          url,
          ok: false,
          last_error_message: answer.lastErrorMessage,
        },
      });
    }

    return { url, ok: true, last_error_message: null };
  }

  /**
   * `POST /admin/alerts/{id}/ack` — скрыть алерт на `minutes` (15…1440).
   *
   * Подтверждение **не чинит** алерт: `value`, `threshold` и `since` остаются
   * прежними, `fired` становится `false` до истечения срока. Хранение — в
   * `admin_audit` (`alert.ack`): журнал уже append-only, и «кто заглушил
   * мониторинг» обязано быть в нём. Отдельная таблица означала бы вторую
   * историю того же действия.
   */
  async ackAlert(actor: AdminActor, id: string, body: unknown): Promise<AlertAckResult> {
    this.ensureAdmin(actor, 'alert.ack');

    if (!this.alerts.ids().includes(id as AlertId)) {
      throw validationFailed({
        message: `Неизвестный алерт: ${id}`,
        details: {
          reason: 'unknown_alert',
          field_errors: [
            { field: 'id', message: `Одно из: ${this.alerts.ids().join(', ')}` },
          ],
        },
      });
    }

    const input = parseAlertAck(body);
    const ackedUntil = new Date(Date.now() + input.minutes * 60_000);

    await this.db.withTransaction(async (client) => {
      await this.audit.write(client, actor, {
        action: 'alert.ack',
        entity: 'alert',
        entityId: id,
        after: {
          minutes: input.minutes,
          acked_until: ackedUntil.toISOString(),
          // Границы здесь же: по журналу видно, что 60 минут — это «по умолчанию»,
          // а 1440 — «на сутки», без похода в код.
          bounds: { min: ALERT_ACK_BOUNDS.min, max: ALERT_ACK_BOUNDS.max },
        },
        reason: `скрыт на ${input.minutes} мин`,
      });
    });

    const list = await this.alerts.list();
    const alert = list.alerts.find((entry) => entry.id === id);

    this.logger.info('admin_alert_acked', {
      alert_id: id,
      minutes: input.minutes,
      acked_until: ackedUntil.toISOString(),
    });

    return {
      acked_until: ackedUntil.toISOString(),
      alert:
        alert ?? {
          id: id as AlertId,
          level: 'warning',
          value: null,
          threshold: 0,
          since: null,
          fired: false,
          acked_until: ackedUntil.toISOString(),
        },
    };
  }

  private ensureAdmin(actor: AdminActor, action: string): void {
    if (!isAdmin(actor, this.env.ADMIN_TG_ID)) {
      this.logger.warn('admin_action_forbidden', { action, reason: 'not_admin' });
    }
    assertAdmin(actor, this.env.ADMIN_TG_ID);
  }
}
