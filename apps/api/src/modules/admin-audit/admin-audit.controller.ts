import { Controller, Get, Inject, Query } from '@nestjs/common';
import { reasonOptions, validationFailed } from '../../common/api-error';
import { APP_ENV } from '../../config/env.module';
import type { AppEnv } from '../../config/env';
import { CurrentAdmin, assertAdmin, type AdminActor } from '../admin-auth/admin-actor';
import { AdminAuditService } from './admin-audit.service';
import type { AdminAuditRow } from './admin-audit.repository';

/**
 * `GET /admin/audit` — лента журнала (1.6.15).
 *
 * Сортировка `at DESC, id DESC`, курсор `(at, id)` — курсор, а не `offset`:
 * журнал пополняется каждый раз, когда админ что-то делает, и `offset` на
 * живой ленте теряет и дублирует строки при каждом сдвиге.
 *
 * `limit > 200` — `422`, а не тихое урезание: «я попросил 500, а получил 200»
 * выглядит как потеря данных.
 */

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export interface AdminAuditItem {
  readonly id: string;
  readonly at: string;
  readonly actor_tg_id: string;
  readonly actor_name: string;
  readonly action: string;
  readonly entity: string;
  readonly entity_id: string | null;
  readonly before: unknown;
  readonly after: unknown;
  readonly reason: string | null;
  readonly request_id: string | null;
}

export interface AdminAuditListResponse {
  readonly items: readonly AdminAuditItem[];
  /** `null` — страниц больше нет. Курсор непрозрачен: панель его не разбирает. */
  readonly next_cursor: string | null;
}

function encodeCursor(row: AdminAuditRow): string {
  return Buffer.from(`${row.at.toISOString()}|${row.id}`, 'utf8').toString('base64url');
}

function decodeCursor(raw: string): { readonly at: Date; readonly id: string } {
  const invalid = validationFailed(reasonOptions('invalid_cursor', 'Курсор не разбирается'));

  let decoded: string;
  try {
    decoded = Buffer.from(raw, 'base64url').toString('utf8');
  } catch {
    throw invalid;
  }

  const separator = decoded.lastIndexOf('|');
  if (separator <= 0) {
    throw invalid;
  }

  const at = new Date(decoded.slice(0, separator));
  const id = decoded.slice(separator + 1);
  if (Number.isNaN(at.getTime()) || !/^\d{1,19}$/.test(id)) {
    throw invalid;
  }

  return { at, id };
}

function text(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

@Controller('admin/audit')
export class AdminAuditController {
  constructor(
    @Inject(AdminAuditService) private readonly audit: AdminAuditService,
    @Inject(APP_ENV) private readonly env: AppEnv,
  ) {}

  @Get()
  async list(
    @CurrentAdmin() actor: AdminActor,
    @Query('entity') entity?: string,
    @Query('entity_id') entityId?: string,
    @Query('action') action?: string,
    @Query('actor_tg_id') actorTgId?: string,
    @Query('limit') limitRaw?: string,
    @Query('cursor') cursorRaw?: string,
  ): Promise<AdminAuditListResponse> {
    // Журнал читает только владелец. Для cookie-пути это уже проверил гард
    // middleware; для `initData` проверка живёт здесь, как и у остальных
    // админских ручек.
    assertAdmin(actor, this.env.ADMIN_TG_ID);

    const limit = limitRaw === undefined ? DEFAULT_LIMIT : Number(limitRaw);
    if (!Number.isInteger(limit) || limit <= 0 || limit > MAX_LIMIT) {
      throw validationFailed(
        reasonOptions('invalid_limit', `limit — целое от 1 до ${MAX_LIMIT}`),
      );
    }

    const actorFilter = text(actorTgId);
    if (actorFilter !== undefined && !/^\d{1,20}$/.test(actorFilter)) {
      throw validationFailed(reasonOptions('invalid_actor_tg_id', 'actor_tg_id — число'));
    }

    // Берём на строку больше, чтобы честно сказать «есть следующая страница».
    const entityFilter = text(entity);
    const entityIdFilter = text(entityId);
    const actionFilter = text(action);

    const rows = await this.audit.list({
      ...(entityFilter === undefined ? {} : { entity: entityFilter }),
      ...(entityIdFilter === undefined ? {} : { entityId: entityIdFilter }),
      ...(actionFilter === undefined ? {} : { action: actionFilter }),
      ...(actorFilter === undefined ? {} : { actorTgId: BigInt(actorFilter) }),
      ...(cursorRaw === undefined || cursorRaw.trim() === ''
        ? {}
        : { cursor: decodeCursor(cursorRaw.trim()) }),
      limit: limit + 1,
    });

    const page = rows.slice(0, limit);
    const last = page[page.length - 1];

    return {
      items: page.map((row) => ({
        id: row.id,
        at: row.at.toISOString(),
        actor_tg_id: row.actor_tg_id,
        actor_name: row.actor_name,
        action: row.action,
        entity: row.entity,
        entity_id: row.entity_id,
        before: row.before,
        after: row.after,
        reason: row.reason,
        request_id: row.request_id,
      })),
      next_cursor: rows.length > limit && last !== undefined ? encodeCursor(last) : null,
    };
  }
}
