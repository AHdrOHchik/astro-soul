import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { AdminActor } from '../admin-auth/admin-actor';
import { internalError, reasonOptions } from '../../common/api-error';
import { JsonLogger } from '../../common/logger';
import { currentRequestId } from '../../common/request-context';
import { DbService } from '../../db/db.service';
import { EventsRepository } from '../events/events.repository';
import { AdminAuditRepository, type AdminAuditRow } from './admin-audit.repository';

/**
 * Аудит действий админа — обязательная часть действия, а не украшение.
 *
 * Правило одно: **нет записи в журнале — нет действия**. Поэтому `write()`
 * принимает клиент транзакции, а не открывает свою: если `INSERT` в журнал
 * упал, вызывающий получит исключение, и его `COMMIT` не случится. Обратное
 * («сначала сделали, потом записали») уже нельзя починить — факт остался бы
 * без автора.
 *
 * Ошибка записи не глотается и не превращается в «предупреждение»: тихая
 * деградация аудита означает, что однажды никто не узнает, кто отозвал доступ.
 * В лог уходит событие `admin_audit_write_failed` — по нему настраивается
 * алерт.
 */

export interface AdminAuditEntry {
  /** Закрытый список: `session.login`, `session.logout`, `code.create`, `grant.create`, … */
  readonly action: string;
  readonly entity: string;
  readonly entityId?: string | null;
  /** Только изменённые поля, без ПДн. */
  readonly before?: Readonly<Record<string, unknown>> | null;
  readonly after?: Readonly<Record<string, unknown>> | null;
  readonly reason?: string | null;
}

/** Служебный «актор» для работ, которые делает не человек (уборка сессий). */
export const SYSTEM_ACTOR: AdminActor = {
  tgId: 0n,
  name: 'system:scheduler',
  via: 'session',
  sessionId: null,
  csrfToken: null,
  expiresAt: null,
};

@Injectable()
export class AdminAuditService {
  constructor(
    @Inject(AdminAuditRepository) private readonly repo: AdminAuditRepository,
    @Inject(DbService) private readonly db: DbService,
    @Inject(EventsRepository) private readonly events: EventsRepository,
    @Inject(JsonLogger) private readonly logger: JsonLogger,
  ) {}

  /** Запись в чужой транзакции: вызывающий коммитит её вместе со своим изменением. */
  async write(client: PoolClient, actor: AdminActor, entry: AdminAuditEntry): Promise<string> {
    try {
      return await this.repo.insert(client, {
        actorTgId: actor.tgId,
        actorName: actor.name,
        action: entry.action,
        entity: entry.entity,
        entityId: entry.entityId ?? null,
        before: entry.before ?? null,
        after: entry.after ?? null,
        reason: entry.reason ?? null,
        requestId: currentRequestId(),
      });
    } catch (error) {
      // Событие без ПДн: действие, сущность и request_id. По нему видно, что
      // журнал недоступен, и что именно не было выполнено.
      this.logger.error('admin_audit_write_failed', {
        action: entry.action,
        entity: entry.entity,
        entity_id: entry.entityId ?? null,
        request_id: currentRequestId(),
        error: error instanceof Error ? error.name : 'unknown',
      });

      // Событие в аналитику — best-effort: если и она недоступна, остаётся лог.
      // Без ПДн: только действие и сущность.
      void this.events
        .log({ name: 'admin_audit_write_failed', props: { action: entry.action, entity: entry.entity } })
        .catch(() => undefined);

      throw internalError(
        reasonOptions(
          'admin_audit_write_failed',
          'Действие не выполнено: журнал аудита недоступен. Повтори позже',
        ),
      );
    }
  }

  /** Своя транзакция — для действий, у которых нет другого изменения. */
  async record(actor: AdminActor, entry: AdminAuditEntry): Promise<string> {
    return this.db.withTransaction((client) => this.write(client, actor, entry));
  }

  list(filters: Parameters<AdminAuditRepository['list']>[0]): Promise<readonly AdminAuditRow[]> {
    return this.repo.list(filters);
  }
}
