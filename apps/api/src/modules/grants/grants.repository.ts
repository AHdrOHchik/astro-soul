import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { GrantKind, GrantSource } from '@astro-soul/shared';
import { DbService } from '../../db/db.service';

/**
 * Чтение и запись `grants`, `founders`, `referrals` (итерация 39).
 *
 * Права выдаются **только** здесь: сервисы выше (`GrantsService`,
 * `AccessCodesService`, `FoundersService`, `ReferralsService`) решают «кому и
 * сколько», а SQL, который двигает счётчики и сроки, живёт в одном файле.
 * Причина та же, что у `PlansRepository`: правка «как продлевается срок» не
 * должна искаться по пяти сервисам.
 *
 * `subscriptions` здесь нет и быть не может: грант — не подписка. Нет
 * `charge_id`, нет автопродления, нет `renewal` — значит, не сработает и алерт
 * `subscription_cancel_no_charge_id_24h`.
 */

export interface GrantRow {
  readonly id: string;
  readonly user_id: string;
  readonly kind: GrantKind;
  readonly source: GrantSource;
  readonly code_id: string | null;
  readonly days: number | null;
  readonly starts_at: Date | null;
  readonly expires_at: Date | null;
  readonly consumed_at: Date | null;
  readonly revoked_at: Date | null;
  readonly created_at: Date;
}

export interface GrantIssueInput {
  readonly userId: string;
  readonly kind: GrantKind;
  readonly source: GrantSource;
  readonly codeId?: string | null;
  /** Для `all_access` обязательны дни; для одноразовых — `null`. */
  readonly days?: number | null;
  /**
   * `true` — срок начинается сразу. `false` — право ждёт построения карты
   * (`starts_at IS NULL`): до карты человек ещё не пользуется продуктом.
   */
  readonly startNow: boolean;
  readonly partnerName?: string | null;
}

const GRANT_COLUMNS = `id, user_id, kind, source, code_id, days, starts_at, expires_at,
                       consumed_at, revoked_at, created_at`;

@Injectable()
export class GrantsRepository {
  constructor(@Inject(DbService) private readonly db: DbService) {}

  /** Все неотозванные права пользователя (включая ожидающие и израсходованные). */
  async listForUser(userId: string): Promise<readonly GrantRow[]> {
    return this.db.query<GrantRow>(
      `SELECT ${GRANT_COLUMNS}
         FROM grants
        WHERE user_id = $1 AND revoked_at IS NULL
        ORDER BY created_at DESC`,
      [userId],
    );
  }

  /**
   * Все права пользователя, включая отозванные — для админского списка.
   *
   * `listForUser` намеренно не отдаёт отозванные: клиенту они не нужны. Админу
   * нужны ровно они — «почему у человека отобрали доступ» отвечается историей,
   * а не логами.
   */
  async listAllForUser(userId: string, limit = 100): Promise<readonly GrantRow[]> {
    return this.db.query<GrantRow>(
      `SELECT ${GRANT_COLUMNS}
         FROM grants
        WHERE user_id = $1
        ORDER BY created_at DESC
        LIMIT $2`,
      [userId, limit],
    );
  }

  /**
   * Выдаёт право.
   *
   * `all_access` не создаёт вторую строку: частичный уникальный индекс
   * `grants_one_all_access_idx` разрешает одно неотозванное право, поэтому
   * повторная выдача **продлевает** срок (см. `extendOrCreateAllAccess`).
   */
  async insert(client: PoolClient, input: GrantIssueInput): Promise<GrantRow> {
    const row = await client.query<GrantRow>(
      `INSERT INTO grants (user_id, kind, source, code_id, days, starts_at, expires_at)
       VALUES (
         $1, $2, $3, $4, $5,
         CASE WHEN $6::boolean THEN now() ELSE NULL END,
         CASE WHEN $6::boolean THEN now() + make_interval(days => $5::int) ELSE NULL END
       )
       RETURNING ${GRANT_COLUMNS}`,
      [input.userId, input.kind, input.source, input.codeId ?? null, input.days ?? null, input.startNow],
    );

    const inserted = row.rows[0];
    if (inserted === undefined) {
      throw new Error('grant_insert_failed');
    }

    return inserted;
  }

  /**
   * Продление действующего (или ожидающего) права «всё включено».
   *
   * Ожидающее право (`starts_at IS NULL`) получает дни «в долг»: срок всё равно
   * начнётся с первой карты, и потерять подаренные дни из-за того, что человек
   * активировал второй код до онбординга, нечестно. Действующее — сдвигает
   * `expires_at` от текущего конца, а не от «сейчас»: иначе второе приглашение
   * обнуляло бы остаток первого.
   */
  async extendAllAccess(
    client: PoolClient,
    userId: string,
    days: number,
    startNow: boolean,
  ): Promise<GrantRow | null> {
    // В одном `UPDATE` две ситуации: ожидающее право и действующее.
    //   • ожидающее и карты всё ещё нет — только копим дни (`expires_at NULL`);
    //   • ожидающее, а карта уже есть — стартуем сейчас на всю сумму дней
    //     (иначе право, выданное до карты, никогда бы не началось: запуск
    //     висит на событии «карта создана», а оно уже прошло);
    //   • действующее — сдвигаем конец от текущего `expires_at`.
    // Postgres берёт в правой части старые значения строки, поэтому порядок
    // присваиваний `starts_at` / `expires_at` безопасен.
    const row = await client.query<GrantRow>(
      `UPDATE grants
          SET days = COALESCE(days, 0) + $2,
              starts_at = CASE WHEN starts_at IS NULL AND $3::boolean THEN now() ELSE starts_at END,
              expires_at = CASE
                WHEN starts_at IS NULL AND NOT $3::boolean THEN NULL
                WHEN starts_at IS NULL AND $3::boolean
                  THEN now() + make_interval(days => COALESCE(days, 0) + $2::int)
                ELSE expires_at + make_interval(days => $2::int)
              END
        WHERE user_id = $1
          AND kind = 'all_access'
          AND revoked_at IS NULL
        RETURNING ${GRANT_COLUMNS}`,
      [userId, days, startNow],
    );

    return row.rows[0] ?? null;
  }

  /**
   * Запуск ожидающих прав: вызывается после первой карты.
   *
   * `RETURNING` нужен не для ответа, а для лога: видно, сколько дней реально
   * начало течь в этот момент.
   */
  async startPending(client: PoolClient, userId: string): Promise<readonly GrantRow[]> {
    const rows = await client.query<GrantRow>(
      `UPDATE grants
          SET starts_at = now(),
              expires_at = now() + make_interval(days => days)
        WHERE user_id = $1
          AND kind = 'all_access'
          AND starts_at IS NULL
          AND revoked_at IS NULL
        RETURNING ${GRANT_COLUMNS}`,
      [userId],
    );

    return rows.rows;
  }

  /**
   * Расход одноразового права — **одним** запросом.
   *
   * Подзапрос с `FOR UPDATE SKIP LOCKED` берёт ровно одну неиспользованную
   * строку; два одновременных запроса (двойной тап «сделать разбор») получают
   * две **разные** строки, а не одну и ту же. Второй при этом увидит `null`,
   * если право было одно, и не пройдёт проверку доступа.
   */
  async consumeSingle(
    client: PoolClient,
    userId: string,
    kind: Exclude<GrantKind, 'all_access'>,
  ): Promise<GrantRow | null> {
    const row = await client.query<GrantRow>(
      `UPDATE grants
          SET consumed_at = now()
        WHERE id = (
          SELECT id FROM grants
           WHERE user_id = $1
             AND kind = $2
             AND consumed_at IS NULL
             AND revoked_at IS NULL
           ORDER BY created_at
           LIMIT 1
           FOR UPDATE SKIP LOCKED
        )
        RETURNING ${GRANT_COLUMNS}`,
      [userId, kind],
    );

    return row.rows[0] ?? null;
  }

  /** Отзыв права (`revoked_at`, не `DELETE`): история выдачи остаётся. */
  async revoke(userId: string, grantId: string, client?: PoolClient): Promise<GrantRow | null> {
    const sql = `UPDATE grants
                    SET revoked_at = now()
                  WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL
                  RETURNING ${GRANT_COLUMNS}`;

    if (client !== undefined) {
      const row = await client.query<GrantRow>(sql, [grantId, userId]);
      return row.rows[0] ?? null;
    }

    return this.db.queryOne<GrantRow>(sql, [grantId, userId]);
  }

  /** Действующее право «всё включено» (для `entitlements` и проверки «есть ли основание продлевать»). */
  async activeAllAccess(userId: string): Promise<GrantRow | null> {
    return this.db.queryOne<GrantRow>(
      `SELECT ${GRANT_COLUMNS}
         FROM grants
        WHERE user_id = $1
          AND kind = 'all_access'
          AND revoked_at IS NULL
          AND (expires_at IS NULL OR expires_at > now())
        ORDER BY starts_at NULLS LAST
        LIMIT 1`,
      [userId],
    );
  }

  /**
   * Место в списке первых 50; `null` — не основатель.
   *
   * Живёт в репозитории грантов, а не в `FoundersService`, потому что нужен
   * биллингу (право купить `founder_month`). Тянуть ради одного `SELECT`
   * сервис с бюджетом и логгером — лишняя зависимость.
   */
  async founderPlace(userId: string): Promise<number | null> {
    const row = await this.db.queryOne<{ place: number }>(
      `SELECT place FROM founders WHERE user_id = $1`,
      [userId],
    );

    return row?.place ?? null;
  }

  /** Сколько дней «всё включено» уже подарено этому человеку из указанного источника. */
  async grantedDaysBySource(userId: string, source: GrantSource): Promise<number> {
    const row = await this.db.queryOne<{ days: number }>(
      `SELECT COALESCE(SUM(COALESCE(days, 0)), 0)::int AS days
         FROM grants
        WHERE user_id = $1 AND source = $2 AND kind = 'all_access' AND revoked_at IS NULL`,
      [userId, source],
    );

    return row?.days ?? 0;
  }
}
