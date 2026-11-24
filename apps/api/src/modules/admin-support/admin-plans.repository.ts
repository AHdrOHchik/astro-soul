import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DbService } from '../../db/db.service';

/**
 * Цены тарифов из панели (контракт 1.6.16).
 *
 * Читается и пишется **только** `plans` — единственный источник цены. Ни
 * `invoices`, ни `payments` в ответе `/admin/plans` не участвуют: витрина и
 * счёт живут по этой таблице, и «цена из панели» обязана быть той же ценой,
 * которую увидит человек.
 *
 * История лежит отдельно (`plan_price_history`, миграция 0039): `plans` хранит
 * только текущее значение, и без истории вопрос «когда подорожали» остаётся без
 * ответа после первого же изменения.
 */
export interface PlanRecord {
  readonly code: string;
  readonly kind: 'one_off' | 'subscription';
  readonly subscription_plan: string;
  readonly title: string;
  /** `plans.stars` — цена в звёздах. В контракте это `price_stars`. */
  readonly stars: number;
  /** `plans.period_seconds`; у разового товара `null`. */
  readonly period_seconds: number | null;
  readonly sort: number;
  readonly is_active: boolean;
  readonly test_only: boolean;
  readonly version: number;
  readonly updated_at: Date;
}

export interface PriceHistoryRow {
  readonly id: string;
  readonly plan_code: string;
  readonly price_stars: number;
  readonly previous_price_stars: number | null;
  readonly version: number;
  readonly comment: string;
  readonly actor_tg_id: string;
  readonly actor_name: string;
  readonly effective_from: Date;
  readonly created_at: Date;
}

const COLUMNS = `code, kind::text AS kind, subscription_plan, title, stars, period_seconds,
  sort, is_active, test_only, version, updated_at`;

const HISTORY_COLUMNS = `id::text AS id, plan_code, price_stars, previous_price_stars, version,
  comment, actor_tg_id::text AS actor_tg_id, actor_name, effective_from, created_at`;

@Injectable()
export class AdminPlansRepository {
  constructor(@Inject(DbService) private readonly db: DbService) {}

  /** Все тарифы, включая неактивные и тестовые: панель показывает правду, не витрину. */
  async list(): Promise<readonly PlanRecord[]> {
    return this.db.query<PlanRecord>(`SELECT ${COLUMNS} FROM plans ORDER BY sort, code`);
  }

  async get(code: string): Promise<PlanRecord | null> {
    return this.db.queryOne<PlanRecord>(`SELECT ${COLUMNS} FROM plans WHERE code = $1`, [code]);
  }

  /**
   * Смена цены с оптимистической блокировкой.
   *
   * `FOR UPDATE` + сверка `version` **внутри** транзакции: две вкладки панели
   * не могут перетереть друг друга молча, вторая получит `current` и `409`.
   * Запись истории идёт здесь же — иначе цена и её объяснение разъезжались бы
   * при откате.
   */
  async updatePrice(
    client: PoolClient,
    input: {
      readonly code: string;
      readonly priceStars: number;
      readonly comment: string;
      readonly baseVersion: number;
      readonly actorTgId: bigint;
      readonly actorName: string;
    },
  ): Promise<
    | { readonly plan: PlanRecord; readonly previousStars: number; readonly effectiveFrom: Date }
    | 'version_mismatch'
    | null
  > {
    const row = await client.query<PlanRecord>(
      `SELECT ${COLUMNS} FROM plans WHERE code = $1 FOR UPDATE`,
      [input.code],
    );
    const current = row.rows[0];

    if (current === undefined) {
      return null;
    }

    if (current.version !== input.baseVersion) {
      return 'version_mismatch';
    }

    const updated = await client.query<PlanRecord>(
      `UPDATE plans
          SET stars = $2, version = version + 1, updated_at = now()
        WHERE code = $1
        RETURNING ${COLUMNS}`,
      [input.code, input.priceStars],
    );

    const plan = updated.rows[0];
    if (plan === undefined) {
      throw new Error('plans: строка исчезла внутри транзакции');
    }

    const history = await client.query<{ effective_from: Date }>(
      `INSERT INTO plan_price_history
         (plan_code, price_stars, previous_price_stars, version, comment, actor_tg_id, actor_name)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING effective_from`,
      [
        plan.code,
        plan.stars,
        current.stars,
        plan.version,
        input.comment,
        input.actorTgId.toString(),
        input.actorName,
      ],
    );

    const effectiveFrom = history.rows[0]?.effective_from;
    if (effectiveFrom === undefined) {
      throw new Error('plans: строка истории цены не записалась');
    }

    return { plan, previousStars: current.stars, effectiveFrom };
  }

  /** История цены тарифа, новое сверху. `null` — тарифа нет. */
  async history(code: string): Promise<readonly PriceHistoryRow[] | null> {
    const plan = await this.get(code);
    if (plan === null) {
      return null;
    }

    return this.db.query<PriceHistoryRow>(
      `SELECT ${HISTORY_COLUMNS}
         FROM plan_price_history
        WHERE plan_code = $1
        ORDER BY effective_from DESC, id DESC
        LIMIT 100`,
      [code],
    );
  }
}
