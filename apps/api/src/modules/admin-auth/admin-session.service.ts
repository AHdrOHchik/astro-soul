import { Inject, Injectable } from '@nestjs/common';
import { createHmac, randomBytes } from 'node:crypto';
import {
  forbidden,
  rateLimited,
  reasonOptions,
  unauthorized,
  validationFailed,
} from '../../common/api-error';
import { JsonLogger } from '../../common/logger';
import { DbService } from '../../db/db.service';
import { APP_ENV } from '../../config/env.module';
import type { AppEnv } from '../../config/env';
import { AdminAuditService, SYSTEM_ACTOR } from '../admin-audit/admin-audit.service';
import { EventsRepository } from '../events/events.repository';
import type { AdminActor } from './admin-actor';
import { AdminLoginThrottle } from './admin-login-throttle.service';
import { AdminSessionsRepository, type AdminSessionRow } from './admin-sessions.repository';
import { verifyTelegramLogin, type TelegramLoginFields } from './telegram-login';

/**
 * Сессии админ-панели: вход, проверка, выход.
 *
 * Всё, что здесь происходит, объясняется одним требованием: **«Выйти» должно
 * означать «выйти»**. Поэтому сессия — строка в базе (`revoked_at`), а не
 * подпись в cookie: подпись нельзя отозвать, пока не истечёт срок.
 *
 * Второе требование — аудит необязательным не бывает. Вход пишет сессию и
 * `session.login` **одной транзакцией**: если журнал недоступен, вход не
 * происходит (а не «происходит без записи»).
 */

/** UUID проверяем до SQL: иначе `WHERE id = 'мусор'` даёт 22P02 и 500. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface AdminLoginInput {
  readonly fields: TelegramLoginFields;
  /** IP запроса. В журнал попадает только хэш — см. `ipHash`. */
  readonly ip: string | undefined;
}

export interface AdminLoginResult {
  readonly session: AdminSessionRow;
  readonly ttlSeconds: number;
}

export interface AdminMeResponse {
  readonly tg_id: string;
  readonly name: string;
  readonly expires_at: string | null;
  readonly csrf_token: string | null;
}

@Injectable()
export class AdminSessionService {
  constructor(
    @Inject(AdminSessionsRepository) private readonly repo: AdminSessionsRepository,
    @Inject(AdminLoginThrottle) private readonly throttle: AdminLoginThrottle,
    @Inject(AdminAuditService) private readonly audit: AdminAuditService,
    @Inject(DbService) private readonly db: DbService,
    @Inject(APP_ENV) private readonly env: AppEnv,
    @Inject(EventsRepository) private readonly events: EventsRepository,
    @Inject(JsonLogger) private readonly logger: JsonLogger,
  ) {}

  /**
   * Серверное событие воронки входа (1.6.15). Без ПДн: ни `tg_id`, ни IP —
   * только факт и причина. Ошибка записи не мешает входу: событие — аналитика,
   * а не аудит (аудит обязателен и живёт в `admin_audit`).
   */
  private logEvent(name: 'admin_login' | 'admin_logout', props: Record<string, unknown>): void {
    void this.events.log({ name, props }).catch((error: unknown) => {
      this.logger.warn('admin_event_failed', {
        name,
        error: error instanceof Error ? error.name : 'unknown',
      });
    });
  }

  /**
   * IP в журнал — только хэшем с перцом. Полный IP в логах админки означал бы,
   * что «кто-то пробовал войти» хранится в открытом виде рядом с `tg_id`:
   * этого достаточно, чтобы связать человека с адресом без судебного запроса.
   */
  ipHash(ip: string | undefined): string {
    return createHmac('sha256', this.env.PSEUDONYM_PEPPER)
      .update(ip ?? 'unknown', 'utf8')
      .digest('hex')
      .slice(0, 16);
  }

  private get ttlSeconds(): number {
    return this.env.ADMIN_SESSION_TTL_HOURS * 3600;
  }

  /**
   * Вход по подписи Telegram Login Widget.
   *
   * Порядок неслучаен:
   *   1. лимит попыток — **до** любой работы с подписью (перебор не должен
   *      стоить серверу HMAC);
   *   2. подпись и окно `auth_date`;
   *   3. `ADMIN_TG_ID` — и только теперь появляется строка сессии.
   *
   * На шаге 3 не-админ получает `403` и **не** оставляет ни сессии, ни записи
   * `session.login`: «зашёл, но не пустили» — это не вход, и журнал не должен
   * утверждать обратное.
   */
  async login(input: AdminLoginInput): Promise<AdminLoginResult> {
    const key = this.ipHash(input.ip);
    const retryAfter = this.throttle.retryAfterSeconds(key);
    if (retryAfter !== null) {
      this.logger.warn('admin_session', {
        action: 'login',
        tg_id: null,
        ip_hash: key,
        ok: false,
        reason: 'throttled',
      });
      this.logEvent('admin_login', { ok: false, reason: 'throttled' });
      throw rateLimited({
        ...reasonOptions('admin_login_throttled'),
        details: { reason: 'admin_login_throttled', retry_after: retryAfter },
      });
    }

    const verified = verifyTelegramLogin(input.fields, this.env.TELEGRAM_BOT_TOKEN);

    if (!verified.ok) {
      this.throttle.registerFailure(key);
      this.logger.warn('admin_session', {
        action: 'login',
        tg_id: null,
        ip_hash: key,
        ok: false,
        reason: verified.reason,
      });
      this.logEvent('admin_login', { ok: false, reason: verified.reason });

      if (verified.reason === 'auth_stale') {
        throw unauthorized(reasonOptions('auth_stale', 'Строка входа просрочена. Открой панель заново'));
      }
      if (verified.reason === 'missing_hash') {
        throw validationFailed(reasonOptions('missing_hash', 'В данных входа нет подписи Telegram'));
      }
      if (verified.reason === 'missing_fields') {
        throw validationFailed(reasonOptions('missing_fields', 'В данных входа нет id или auth_date'));
      }
      if (verified.reason === 'malformed') {
        throw validationFailed(reasonOptions('malformed', 'Данные входа имеют неверный тип'));
      }
      throw unauthorized(reasonOptions('invalid_hash', 'Подпись Telegram не совпала'));
    }

    if (this.env.ADMIN_TG_ID === undefined || BigInt(this.env.ADMIN_TG_ID) !== verified.tgId) {
      this.throttle.registerFailure(key);
      this.logger.warn('admin_session', {
        action: 'login',
        tg_id: verified.tgId.toString(),
        ip_hash: key,
        ok: false,
        reason: 'not_admin',
      });
      this.logEvent('admin_login', { ok: false, reason: 'not_admin' });
      throw forbidden(reasonOptions('admin_only', 'Доступ к панели есть только у владельца'));
    }

    const expiresAt = new Date(Date.now() + this.ttlSeconds * 1000);
    const csrfToken = randomBytes(32).toString('hex');

    const session = await this.db.withTransaction(async (client) => {
      const row = await this.repo.insert(client, {
        tgId: verified.tgId,
        name: verified.name,
        csrfToken,
        expiresAt,
      });

      await this.audit.write(
        client,
        {
          tgId: verified.tgId,
          name: verified.name,
          via: 'session',
          sessionId: row.id,
          csrfToken,
          expiresAt: row.expires_at,
        },
        {
          action: 'session.login',
          entity: 'session',
          entityId: row.id,
          after: { expires_at: row.expires_at.toISOString() },
        },
      );

      return row;
    });

    this.throttle.registerSuccess(key);
    this.logger.info('admin_session', {
      action: 'login',
      tg_id: verified.tgId.toString(),
      ip_hash: key,
      ok: true,
    });
    this.logEvent('admin_login', { ok: true });

    return { session, ttlSeconds: this.ttlSeconds };
  }

  /** Живая сессия по cookie; `null` — нет, просрочена или отозвана. */
  async resolve(cookieValue: string): Promise<AdminSessionRow | null> {
    const row = await this.findAny(cookieValue);
    if (row === null) {
      return null;
    }
    if (row.revoked_at !== null || row.expires_at.getTime() <= Date.now()) {
      return null;
    }

    // `last_seen_at` — не чаще раза в минуту; запись не должна задерживать
    // ответ админки и не должна ронять запрос, если база тормознула.
    void this.repo.touch(row.id).catch((error: unknown) => {
      this.logger.warn('admin_session_touch_failed', {
        error: error instanceof Error ? error.name : 'unknown',
      });
    });

    return row;
  }

  /** Для выхода: строка нужна в любом состоянии, включая уже отозванную. */
  async findAny(cookieValue: string): Promise<AdminSessionRow | null> {
    if (!UUID_PATTERN.test(cookieValue)) {
      return null;
    }
    return this.repo.findById(cookieValue);
  }

  /**
   * Выход. Идемпотентен: повтор с отозванной сессией — `200` и ничего не
   * меняет (событие второй раз не пишется: писать «вышел» дважды — врать в
   * журнале).
   */
  async logout(cookieValue: string | undefined): Promise<{ readonly revoked: boolean }> {
    if (cookieValue === undefined) {
      return { revoked: false };
    }

    const row = await this.findAny(cookieValue);
    if (row === null || row.revoked_at !== null || row.expires_at.getTime() <= Date.now()) {
      return { revoked: false };
    }

    const actor: AdminActor = {
      tgId: BigInt(row.tg_id),
      name: row.name,
      via: 'session',
      sessionId: row.id,
      csrfToken: row.csrf_token,
      expiresAt: row.expires_at,
    };

    const revoked = await this.db.withTransaction(async (client) => {
      const updated = await this.repo.revoke(client, row.id);
      if (updated === null) {
        return null;
      }

      await this.audit.write(client, actor, {
        action: 'session.logout',
        entity: 'session',
        entityId: row.id,
        before: { revoked_at: null },
        after: { revoked_at: updated.revoked_at?.toISOString() ?? null },
      });

      return updated;
    });

    this.logger.info('admin_session', {
      action: 'logout',
      tg_id: row.tg_id,
      ip_hash: null,
      ok: true,
    });
    this.logEvent('admin_logout', {});

    return { revoked: revoked !== null };
  }

  /** `GET /admin/me`: имя — из снимка сессии, не из `users`. */
  me(actor: AdminActor): AdminMeResponse {
    return {
      tg_id: actor.tgId.toString(),
      name: actor.name,
      expires_at: actor.expiresAt === null ? null : actor.expiresAt.toISOString(),
      csrf_token: actor.csrfToken,
    };
  }

  countActive(): Promise<number> {
    return this.repo.countActive();
  }

  /**
   * Уборка просроченных сессий: `expires_at < now() - days`.
   *
   * Удаление и запись `session.purge` — одна транзакция. Не для красоты:
   * «убрали строки, а сколько — неизвестно» превращает метрику
   * `admin_sessions_purged_24h` в догадку.
   */
  async purge(days: number): Promise<number> {
    return this.db.withTransaction(async (client) => {
      const purged = await this.repo.purgeExpired(days, client);

      await this.audit.write(client, SYSTEM_ACTOR, {
        action: 'session.purge',
        entity: 'session',
        after: { purged, older_than_days: days },
      });

      if (purged > 0) {
        this.logger.info('admin_sessions_purged', { purged, older_than_days: days });
      }

      return purged;
    });
  }
}
