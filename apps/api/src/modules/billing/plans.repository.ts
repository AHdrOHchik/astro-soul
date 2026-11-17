import { Inject, Injectable } from '@nestjs/common';
import type {
  OneOffGrant,
  PlanCode,
  PlanGrants,
  PlanKind,
  SubscriptionGrant,
  SubscriptionPlan,
} from '@astro-soul/shared';
import { DbService } from '../../db/db.service';

/**
 * Единственный резолвер цен: читает **только** таблицу `plans`.
 *
 * Итерация 23 (дополнение). До этого цена приходила из
 * `packages/shared/src/plans.ts`, таблица `plans` была её «зеркалом», а
 * `plan-offers.ts` держал третью копию. Владелец правил цену в БД — витрина
 * показывала старое, правил в файле — менялась витрина, а Telegram выставлял
 * сумму из третьего места.
 *
 * Кэша нет намеренно: `SELECT` по первичному ключу стоит меньше, чем любая
 * инвалидация, а требование «правка в БД действует без перезапуска API» при
 * кэше в 30–60 секунд выполнялось бы с оговоркой. Здесь — сразу.
 */
export interface PlanRowBase {
  readonly code: PlanCode;
  readonly subscriptionPlan: SubscriptionPlan;
  /** Цена в звёздах на момент чтения. Для инвойса — снимок в `invoices.stars`. */
  readonly stars: number;
  readonly title: string;
  readonly description: string;
  readonly priceLabel: string;
  readonly paywallTitle: string;
  readonly paywallSubtitle: string;
  readonly sort: number;
  /** `test_only`: тариф существует только при `PAYMENTS_TEST_PLANS=1`. */
  readonly testOnly: boolean;
  /** `is_active`: тариф продаётся. Тестовые строки лежат неактивными. */
  readonly active: boolean;
}

export interface OneOffPlanRow extends PlanRowBase {
  readonly kind: 'one_off';
  readonly periodSeconds: null;
  readonly grant: OneOffGrant;
}

export interface SubscriptionPlanRow extends PlanRowBase {
  readonly kind: 'subscription';
  readonly periodSeconds: number;
  readonly grants: SubscriptionGrant;
}

export type PlanRow = OneOffPlanRow | SubscriptionPlanRow;

interface PlanDbRow {
  readonly code: string;
  readonly kind: PlanKind;
  readonly subscription_plan: string;
  readonly stars: number;
  readonly period_seconds: number | null;
  readonly title: string;
  readonly description: string;
  readonly price_label: string;
  readonly paywall_title: string;
  readonly paywall_subtitle: string;
  readonly grants: PlanGrants;
  readonly sort: number;
  readonly is_active: boolean;
  readonly test_only: boolean;
}

const SELECT_COLUMNS = `code, kind, subscription_plan, stars, period_seconds, title, description,
                        price_label, paywall_title, paywall_subtitle, grants, sort,
                        is_active, test_only`;

function subscriptionPlanOf(value: string): SubscriptionPlan {
  switch (value) {
    case 'trial':
    case 'week':
    case 'month':
    case 'year':
    case 'none':
      return value;
    default:
      // План с неизвестным `subscription_plan` — это испорченная строка, а не
      // повод выдать человеку права «на глаз».
      throw new Error(`plans: неизвестный subscription_plan «${value}»`);
  }
}

/** Строка БД → план. Битые права — ошибка конфигурации, а не «план без прав». */
export function planFromRow(row: PlanDbRow): PlanRow {
  const base = {
    code: row.code as PlanCode,
    subscriptionPlan: subscriptionPlanOf(row.subscription_plan),
    stars: row.stars,
    title: row.title,
    description: row.description,
    priceLabel: row.price_label,
    paywallTitle: row.paywall_title,
    paywallSubtitle: row.paywall_subtitle,
    sort: row.sort,
    testOnly: row.test_only,
    active: row.is_active,
  };

  if (row.kind === 'one_off') {
    const grant = (row.grants as { grant?: unknown }).grant;
    if (grant !== 'report' && grant !== 'compat' && grant !== 'solar') {
      throw new Error(`plans: у разового плана ${row.code} нет корректного grants.grant`);
    }
    return { ...base, kind: 'one_off', periodSeconds: null, grant };
  }

  const grants = row.grants as Partial<SubscriptionGrant>;
  if (
    typeof grants.fullForecast !== 'boolean' ||
    typeof grants.askPerDay !== 'number' ||
    typeof grants.compatPerMonth !== 'number' ||
    typeof grants.solarIncluded !== 'boolean'
  ) {
    throw new Error(`plans: у подписки ${row.code} нет корректного grants`);
  }

  return {
    ...base,
    kind: 'subscription',
    periodSeconds: row.period_seconds ?? 0,
    grants: {
      fullForecast: grants.fullForecast,
      askPerDay: grants.askPerDay,
      compatPerMonth: grants.compatPerMonth,
      solarIncluded: grants.solarIncluded,
    },
  };
}

@Injectable()
export class PlansRepository {
  constructor(@Inject(DbService) private readonly db: DbService) {}

  /**
   * План по коду. Возвращает и неактивные, и тестовые строки: решение «можно
   * ли это продавать» принимает вызывающий, зная флаг и `active`/`testOnly`.
   */
  async getPlan(code: string): Promise<PlanRow | null> {
    const row = await this.db.queryOne<PlanDbRow>(
      `SELECT ${SELECT_COLUMNS} FROM plans WHERE code = $1`,
      [code],
    );

    return row === null ? null : planFromRow(row);
  }

  /**
   * Витрина: каталог (`is_active`, не тестовые) и, при включённом флаге,
   * тестовые строки в конце — тем же порядком `sort`, что и в каталоге.
   */
  async listPlans(includeTestPlans: boolean): Promise<readonly PlanRow[]> {
    const rows = await this.db.query<PlanDbRow>(
      `SELECT ${SELECT_COLUMNS}
         FROM plans
        WHERE (is_active AND NOT test_only) OR ($1 AND test_only)
        ORDER BY sort, code`,
      [includeTestPlans],
    );

    return rows.map(planFromRow);
  }

  /**
   * План подписки по её слагу (`subscriptions.plan`): им `EntitlementsService`
   * отвечает на вопрос «что даёт действующая подписка».
   */
  async getSubscriptionPlan(plan: 'week' | 'month' | 'year'): Promise<SubscriptionPlanRow | null> {
    const row = await this.db.queryOne<PlanDbRow>(
      `SELECT ${SELECT_COLUMNS}
         FROM plans
        WHERE kind = 'subscription' AND subscription_plan = $1 AND NOT test_only
        ORDER BY sort
        LIMIT 1`,
      [plan],
    );

    if (row === null) {
      return null;
    }

    const mapped = planFromRow(row);
    return mapped.kind === 'subscription' ? mapped : null;
  }
}
