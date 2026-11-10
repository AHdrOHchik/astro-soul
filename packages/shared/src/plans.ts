/**
 * Единственное место, где хранятся цены и состав планов (payments.md §1).
 * Таблица `plans` в БД — зеркало этого файла, синхронизируется `pnpm db:seed`.
 * Хардкод цены в обработчике платежа — ошибка ревью.
 */

/** Коды планов из payments.md §1. */
export const PLAN_CODES = [
  'one_149',
  'week_149',
  'month_399',
  'year_2990',
  'compat_249',
  'solar_590',
] as const;

export type PlanCode = (typeof PLAN_CODES)[number];

export type PlanKind = 'one_off' | 'subscription';

/** Значения `SubscriptionState.plan` из контракта. */
export type SubscriptionPlan = 'none' | 'trial' | 'week' | 'month' | 'year';

/** Что именно выдаёт разовый товар. */
export type OneOffGrant = 'report' | 'compat' | 'solar';

/** Доступ, который даёт действующая подписка. */
export interface SubscriptionGrant {
  readonly fullForecast: boolean;
  readonly askPerDay: number;
  readonly compatPerMonth: number;
  readonly solarIncluded: boolean;
}

export interface PlanBase {
  readonly code: PlanCode;
  /** Значение `plan` в `SubscriptionState` для подписок, `none` для разовых товаров. */
  readonly subscriptionPlan: SubscriptionPlan;
  /** Цена в звёздах (XTR). Только целое число. */
  readonly stars: number;
  /** Заголовок инвойса (ru). */
  readonly title: string;
  /** Описание инвойса (ru). */
  readonly description: string;
  /** Подпись суммы в `prices[]` инвойса (ru). */
  readonly priceLabel: string;
  /** Порядок на пейволле. */
  readonly sort: number;
}

export interface OneOffPlan extends PlanBase {
  readonly kind: 'one_off';
  /** `subscription_period` для разового товара не передаётся. */
  readonly periodSeconds: null;
  readonly grant: OneOffGrant;
}

export interface SubscriptionPlanDefinition extends PlanBase {
  readonly kind: 'subscription';
  /** `subscription_period` в секундах — обязателен для подписки. */
  readonly periodSeconds: number;
  readonly grants: SubscriptionGrant;
}

export type Plan = OneOffPlan | SubscriptionPlanDefinition;

export const PLANS: Readonly<Record<PlanCode, Plan>> = {
  one_149: {
    code: 'one_149',
    kind: 'one_off',
    subscriptionPlan: 'none',
    stars: 149,
    periodSeconds: null,
    grant: 'report',
    title: 'Разбор личности — полный разбор',
    description: 'Шесть глав по вашей натальной карте и PDF',
    priceLabel: 'Разбор',
    sort: 10,
  },
  week_149: {
    code: 'week_149',
    kind: 'subscription',
    subscriptionPlan: 'week',
    stars: 149,
    periodSeconds: 604800,
    grants: { fullForecast: true, askPerDay: 5, compatPerMonth: 1, solarIncluded: false },
    title: 'Разбор личности — подписка на неделю',
    description: 'Ежедневный прогноз, 5 вопросов в день, совместимость 1 в месяц',
    priceLabel: 'Неделя',
    sort: 20,
  },
  month_399: {
    code: 'month_399',
    kind: 'subscription',
    subscriptionPlan: 'month',
    stars: 399,
    periodSeconds: 2592000,
    grants: { fullForecast: true, askPerDay: 5, compatPerMonth: 1, solarIncluded: false },
    title: 'Разбор личности — подписка на месяц',
    description: 'Ежедневный прогноз, 5 вопросов в день, совместимость 1 в месяц',
    priceLabel: 'Месяц',
    sort: 30,
  },
  year_2990: {
    code: 'year_2990',
    kind: 'subscription',
    subscriptionPlan: 'year',
    stars: 2990,
    periodSeconds: 31536000,
    grants: { fullForecast: true, askPerDay: 5, compatPerMonth: 1, solarIncluded: true },
    title: 'Разбор личности — подписка на год',
    description: 'Всё, что в месячной подписке, плюс карта года',
    priceLabel: 'Год',
    sort: 40,
  },
  compat_249: {
    code: 'compat_249',
    kind: 'one_off',
    subscriptionPlan: 'none',
    stars: 249,
    periodSeconds: null,
    grant: 'compat',
    title: 'Совместимость с партнёром',
    description: 'Разбор пары по двум натальным картам',
    priceLabel: 'Совместимость',
    sort: 50,
  },
  solar_590: {
    code: 'solar_590',
    kind: 'one_off',
    subscriptionPlan: 'none',
    stars: 590,
    periodSeconds: null,
    grant: 'solar',
    title: 'Карта года',
    description: 'Прогноз на год вперёд по солярной карте',
    priceLabel: 'Карта года',
    sort: 60,
  },
} as const;

/** Планы в порядке пейволла. */
export const PLANS_ORDERED: readonly Plan[] = Object.values(PLANS).sort((a, b) => a.sort - b.sort);

export function isPlanCode(value: unknown): value is PlanCode {
  return typeof value === 'string' && (PLAN_CODES as readonly string[]).includes(value);
}

/**
 * Цена в звёздах по коду плана. Клиент не может прислать `amount` —
 * он всегда берётся отсюда (payments.md §2).
 */
export function priceOf(code: PlanCode): number {
  return PLANS[code].stars;
}

/** Период подписки для `createInvoiceLink`; `undefined` для разового товара. */
export function subscriptionPeriodOf(code: PlanCode): number | undefined {
  const plan = PLANS[code];
  return plan.kind === 'subscription' ? plan.periodSeconds : undefined;
}
