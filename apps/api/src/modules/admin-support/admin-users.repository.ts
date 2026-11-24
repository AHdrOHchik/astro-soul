import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DbService } from '../../db/db.service';
import type { AdminUserSearch } from './admin-support.dto';

/**
 * Пользователи глазами поддержки (контракт 1.6.16).
 *
 * Главное правило файла: **список без ПДн**. `GET /admin/users` отдаёт
 * псевдоним, признаки и даты, но не дату/время/место рождения и не текст
 * карты — даже если фильтр — сам `telegram_id`. Дата рождения есть только в
 * карточке (`GET /admin/users/{id}`), и её чтение пишется в `admin_audit`
 * (`user.card_view`): «посмотрел данные человека» — это событие, а не
 * бесплатное чтение.
 *
 * Псевдоним (`alias`) — производное от `users.id`, а не имя из Telegram: имя в
 * базе не хранится вовсе (и это осознанно — ПДн в базе меньше, чем в
 * Telegram). Формат `u-<8 hex>` стабилен и не позволяет восстановить
 * `telegram_id`.
 *
 * Подписки здесь не читаются вовсе: прямой запрос к таблице подписок вне
 * `billing`/`entitlements`/`ops` запрещён стражем
 * (`grants-access-guard.spec.ts`).
 * Состояние подписки спрашивает `EntitlementsService`.
 */
export interface AdminUserRow {
  readonly user_id: string;
  readonly alias: string;
  readonly created_at: Date;
  readonly last_seen_at: Date | null;
  readonly banned_at: Date | null;
  readonly ban_reason: string | null;
  readonly push_enabled: boolean;
}

export interface AdminProfileRow {
  readonly birth_date: string;
  readonly birth_time: string | null;
  /** В БД колонка называется `time_mode` (0006), в контракте — `time_precision`. */
  readonly time_precision: string;
  readonly place_name: string;
  readonly place_region: string | null;
  readonly place_country: string;
  readonly place_tz: string;
  readonly consent_at: Date;
}

export interface AdminChartRow {
  readonly id: string;
  readonly time_known: boolean;
  readonly engine_version: string;
  readonly created_at: Date;
}

export interface AdminPaymentRow {
  readonly telegram_payment_charge_id: string;
  readonly plan_code: string;
  readonly total_amount: number;
  readonly status: string;
  readonly is_test: boolean;
  readonly paid_at: Date;
  readonly refunded_at: Date | null;
}

export interface AdminGrantRow {
  readonly id: string;
  readonly kind: string;
  readonly source: string;
  readonly days: number | null;
  readonly starts_at: Date | null;
  readonly expires_at: Date | null;
  readonly consumed_at: Date | null;
  readonly revoked_at: Date | null;
  readonly created_at: Date;
}

export interface AdminUserCounts {
  readonly reports: number;
  readonly compatibility: number;
  readonly questions: number;
  readonly forecasts: number;
}

/** Псевдоним в SQL — одна формула на чтение и на поиск, иначе поиск «не находит». */
const ALIAS_SQL = `('u-' || substr(replace(u.id::text, '-', ''), 1, 8))`;

const USER_COLUMNS = `u.id::text AS user_id, ${ALIAS_SQL} AS alias, u.created_at, u.last_seen_at,
  u.banned_at, u.ban_reason, u.push_enabled`;

const LIST_LIMIT = 20;

@Injectable()
export class AdminUsersRepository {
  constructor(@Inject(DbService) private readonly db: DbService) {}

  /**
   * Поиск ровно по одному фильтру, 20 строк + признак «есть ещё».
   * `LIMIT 21` — так «обрезано» видно без второго `COUNT(*)` по всей таблице.
   */
  async search(search: AdminUserSearch): Promise<{ rows: readonly AdminUserRow[]; truncated: boolean }> {
    let where: string;
    let params: unknown[];

    switch (search.by) {
      case 'telegram_id':
        where = 'u.telegram_id = $1';
        params = [search.telegramId.toString()];
        break;
      case 'alias':
        where = `lower(${ALIAS_SQL}) = lower(ltrim($1, '@'))`;
        params = [search.alias];
        break;
      case 'q':
        where = `(${ALIAS_SQL} ILIKE '%' || $1 || '%' OR u.telegram_id::text LIKE '%' || $1 || '%')`;
        params = [search.q];
        break;
    }

    const rows = await this.db.query<AdminUserRow>(
      `SELECT ${USER_COLUMNS}
         FROM users u
        WHERE ${where}
        ORDER BY u.created_at DESC, u.id
        LIMIT ${LIST_LIMIT + 1}`,
      params,
    );

    return { rows: rows.slice(0, LIST_LIMIT), truncated: rows.length > LIST_LIMIT };
  }

  async byId(userId: string): Promise<AdminUserRow | null> {
    return this.db.queryOne<AdminUserRow>(
      `SELECT ${USER_COLUMNS} FROM users u WHERE u.id = $1`,
      [userId],
    );
  }

  /** `telegram_id` — только для карточки и только в ответе под аудитом. */
  async telegramIdOf(userId: string): Promise<string | null> {
    const row = await this.db.queryOne<{ telegram_id: string }>(
      `SELECT telegram_id::text AS telegram_id FROM users WHERE id = $1`,
      [userId],
    );
    return row?.telegram_id ?? null;
  }

  async profile(userId: string): Promise<AdminProfileRow | null> {
    return this.db.queryOne<AdminProfileRow>(
      `SELECT birth_date::text AS birth_date, birth_time::text AS birth_time,
              time_mode::text AS time_precision,
              place_name, place_region, place_country, place_tz, consent_at
         FROM profiles WHERE user_id = $1`,
      [userId],
    );
  }

  async chart(userId: string): Promise<AdminChartRow | null> {
    return this.db.queryOne<AdminChartRow>(
      `SELECT id::text AS id, time_known, engine_version, created_at
         FROM charts WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [userId],
    );
  }

  async payments(userId: string): Promise<readonly AdminPaymentRow[]> {
    return this.db.query<AdminPaymentRow>(
      `SELECT telegram_payment_charge_id, plan_code, total_amount, status::text AS status,
              is_test, paid_at, refunded_at
         FROM payments WHERE user_id = $1
        ORDER BY paid_at DESC
        LIMIT 50`,
      [userId],
    );
  }

  async grants(userId: string): Promise<readonly AdminGrantRow[]> {
    return this.db.query<AdminGrantRow>(
      `SELECT id::text AS id, kind, source, days, starts_at, expires_at, consumed_at, revoked_at,
              created_at
         FROM grants WHERE user_id = $1
        ORDER BY created_at DESC
        LIMIT 50`,
      [userId],
    );
  }

  /**
   * Счётчики и стоимость LLM одним запросом.
   *
   * Стоимость — сумма трёх источников (разборы/совместимости, прогнозы дня,
   * вопросы): это те же таблицы, по которым считаются метрики владельца, и
   * «сколько стоил этот человек» должно сходиться с ними, а не с четвёртой
   * формулой.
   */
  async countsAndCost(userId: string): Promise<{ counts: AdminUserCounts; costRub: number }> {
    const row = await this.db.queryOne<{
      reports: string;
      compatibility: string;
      questions: string;
      forecasts: string;
      reports_cost: string;
      questions_cost: string;
      forecast_cost: string;
    }>(
      `SELECT
         (SELECT count(*) FROM reports WHERE user_id = $1 AND kind = 'report')::text AS reports,
         (SELECT count(*) FROM reports WHERE user_id = $1 AND kind = 'compat')::text AS compatibility,
         (SELECT count(*) FROM questions WHERE user_id = $1)::text AS questions,
         (SELECT count(*) FROM daily_forecasts WHERE user_id = $1)::text AS forecasts,
         (SELECT COALESCE(sum(llm_cost_rub), 0) FROM reports WHERE user_id = $1)::text AS reports_cost,
         (SELECT COALESCE(sum(cost_rub), 0) FROM questions WHERE user_id = $1)::text AS questions_cost,
         (SELECT COALESCE(sum(cost_rub), 0) FROM daily_forecasts WHERE user_id = $1)::text AS forecast_cost`,
      [userId],
    );

    return {
      counts: {
        reports: Number(row?.reports ?? '0'),
        compatibility: Number(row?.compatibility ?? '0'),
        questions: Number(row?.questions ?? '0'),
        forecasts: Number(row?.forecasts ?? '0'),
      },
      costRub:
        Math.round(
          (Number(row?.reports_cost ?? '0') +
            Number(row?.questions_cost ?? '0') +
            Number(row?.forecast_cost ?? '0')) *
            10_000,
        ) / 10_000,
    };
  }

  /** Платёж по `charge_id` — для возврата. `null` — такого нет вообще. */
  async paymentByChargeId(chargeId: string): Promise<{
    id: string;
    user_id: string | null;
    telegram_id: string | null;
    plan_code: string;
    total_amount: number;
    status: string;
    refunded_at: Date | null;
  } | null> {
    return this.db.queryOne(
      `SELECT id::text AS id, user_id::text AS user_id, telegram_id::text AS telegram_id,
              plan_code, total_amount, status::text AS status, refunded_at
         FROM payments WHERE telegram_payment_charge_id = $1`,
      [chargeId],
    );
  }

  /**
   * Отметка возврата. **Без** отзыва прав и **без** отмены подписки: возврат в
   * этой волне — про деньги, а доступ закрывается осознанно (`ban`) или
   * отдельным решением. Тихо снимать доступ за возврат 199 ⭐ значило бы
   * ломать людям разбор, за который они уже получили текст.
   */
  async markRefunded(client: PoolClient, paymentId: string): Promise<Date | null> {
    const row = await client.query<{ refunded_at: Date }>(
      `UPDATE payments
          SET status = 'refunded', refunded_at = now(), updated_at = now()
        WHERE id = $1 AND status <> 'refunded'
        RETURNING refunded_at`,
      [paymentId],
    );

    return row.rows[0]?.refunded_at ?? null;
  }

  /**
   * Местные сутки человека для журнала пуша — по поясу места рождения, как у
   * утренней рассылки. Нет профиля — UTC: «сегодня» без пояса всё равно нужно,
   * а выдумывать пояс нельзя.
   */
  async localDateOf(userId: string): Promise<string> {
    const row = await this.db.queryOne<{ local_date: string }>(
      `SELECT (now() AT TIME ZONE COALESCE(p.place_tz, 'UTC'))::date::text AS local_date
         FROM users u LEFT JOIN profiles p ON p.user_id = u.id
        WHERE u.id = $1`,
      [userId],
    );

    return row?.local_date ?? new Date().toISOString().slice(0, 10);
  }

  /**
   * Заявка на тестовый пуш. Уникальность `(user_id, local_date, kind)` — та же,
   * что у утренней рассылки, поэтому второй тестовый пуш за сутки невозможен
   * на уровне БД: `kind = 'test'` входит в тот же ключ.
   */
  async claimTestPush(client: PoolClient, userId: string, localDate: string): Promise<boolean> {
    const row = await client.query<{ id: string }>(
      `INSERT INTO push_log (user_id, local_date, kind, sent)
       VALUES ($1, $2::date, 'test', false)
       ON CONFLICT (user_id, local_date, kind) DO NOTHING
       RETURNING id`,
      [userId, localDate],
    );

    return row.rows.length > 0;
  }

  /** Итог тестового пуша: `null` — ушёл. Возвращает момент отправки. */
  async finishTestPush(userId: string, localDate: string, error: string | null): Promise<Date | null> {
    const row = await this.db.queryOne<{ sent_at: Date }>(
      `UPDATE push_log SET error = $3, sent = ($3::text IS NULL)
        WHERE user_id = $1 AND local_date = $2::date AND kind = 'test'
        RETURNING sent_at`,
      [userId, localDate, error],
    );

    return row?.sent_at ?? null;
  }

  async setBan(
    client: PoolClient,
    userId: string,
    input: { readonly banned: boolean; readonly reason: string },
  ): Promise<{ readonly banned_at: Date | null; readonly ban_reason: string | null } | null> {
    const row = await client.query<{ banned_at: Date | null; ban_reason: string | null }>(
      `UPDATE users
          SET banned_at = CASE WHEN $2 THEN COALESCE(banned_at, now()) ELSE NULL END,
              ban_reason = CASE WHEN $2 THEN $3 ELSE NULL END
        WHERE id = $1
        RETURNING banned_at, ban_reason`,
      [userId, input.banned, input.reason],
    );

    return row.rows[0] ?? null;
  }
}
