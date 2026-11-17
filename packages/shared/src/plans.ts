/**
 * Планы: коды, типы и форма прав. **Цен здесь нет.**
 *
 * Итерация 23 (дополнение): единственный источник цен — таблица `plans` в БД
 * (`payments.md` §1). Этот файл остался тем, чем должен быть: закрытым
 * перечнем кодов контракта и типами. Значения (цена, тексты, права) читает
 * `apps/api/src/modules/billing/plans.repository.ts`; сид для пустой базы —
 * `apps/api/src/db/plans-seed.ts`.
 *
 * Почему цены убраны отсюда насовсем: пока число лежало в двух местах, правка
 * одного из них давала три разных ответа — витрину из одного каталога, счёт из
 * другого и сумму в окне Telegram из третьего. Тест-страж
 * (`apps/api/test/plans-single-source.spec.ts`) падает на цене в коде.
 */

/** Коды планов из payments.md §1 — каталог, который видит клиент. */
export const PLAN_CODES = [
  'one_149',
  'week_149',
  'month_399',
  'year_2990',
  'compat_249',
  'solar_590',
] as const;

/**
 * Тестовые тарифы: существуют только при `PAYMENTS_TEST_PLANS=1`.
 *
 * Строки в `plans` есть (сид, `test_only = true`), но в каталог они не входят
 * никогда: `GET /billing/plans` отдаёт их только при включённом флаге и с
 * `test: true`, а `POST /billing/invoice` без флага отвечает `422`, как будто
 * плана нет. Флаг один на оба тарифа намеренно: два выключателя — это один
 * забытый.
 */
export const TEST_PLAN_CODES = ['test_1', 'test_report_1'] as const;

/** Всё, что сервер умеет выставлять в инвойсе: каталог + тестовые. */
export const ALL_PLAN_CODES = [...PLAN_CODES, ...TEST_PLAN_CODES] as const;

export type CataloguePlanCode = (typeof PLAN_CODES)[number];
export type TestPlanCode = (typeof TEST_PLAN_CODES)[number];
export type PlanCode = (typeof ALL_PLAN_CODES)[number];

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

/** Права разового товара: одна строка `kind = 'one_off'` в `plans.grants`. */
export interface OneOffPlanGrants {
  readonly grant: OneOffGrant;
}

/** `plans.grants` в БД: либо права разового товара, либо права подписки. */
export type PlanGrants = OneOffPlanGrants | SubscriptionGrant;

export function isOneOffGrants(value: PlanGrants): value is OneOffPlanGrants {
  return typeof (value as OneOffPlanGrants).grant === 'string';
}

/**
 * Минимум, который нужен `entitlementsForPlan`: вид плана и его права.
 * Намеренно структурный тип, а не ссылка на каталог: права приходят из БД.
 */
export interface PlanRightsSource {
  readonly kind: PlanKind;
  readonly subscriptionPlan: SubscriptionPlan;
  readonly grant?: OneOffGrant;
  readonly grants?: SubscriptionGrant;
}

/**
 * Код из каталога. Тестовые коды сюда не входят намеренно: этой проверкой
 * отвечают на вопрос «это план, который видит клиент», а не «сервер умеет
 * такой выставить» (для второго — `ALL_PLAN_CODES`).
 */
export function isPlanCode(value: unknown): value is CataloguePlanCode {
  return typeof value === 'string' && (PLAN_CODES as readonly string[]).includes(value);
}

/** Тестовый тариф: существует только при явно включённом флаге. */
export function isTestPlanCode(value: unknown): value is TestPlanCode {
  return typeof value === 'string' && (TEST_PLAN_CODES as readonly string[]).includes(value);
}
