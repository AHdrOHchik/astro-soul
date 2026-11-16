/**
 * Единственное место, где хранятся цены и состав планов (payments.md §1).
 * Таблица `plans` в БД — зеркало этого файла, синхронизируется `pnpm db:seed`.
 * Хардкод цены в обработчике платежа — ошибка ревью.
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
 * Тестовые тарифы: существуют в коде, но не в каталоге.
 *
 * `test_1` нужен владельцу, чтобы пройти настоящий путь оплаты в клиенте
 * Telegram за 1 ⭐, а не за 399. Такой тариф нельзя «просто добавить в
 * таблицу цен»: любая забытая строка в каталоге — это прод, где подписка
 * стоит звезду. Поэтому у плана есть признак `testOnly`, а у сервера —
 * флаг `PAYMENTS_TEST_PLANS`: при выключенном флаге `POST /billing/invoice`
 * с этим кодом отвечает `422`, как будто плана нет.
 *
 * В каталог (`PLAN_CODES`), в порядок пейволла (`PLANS_ORDERED`) и в контракт
 * эти коды не попадают никогда: клиент о них не знает, вызывает их только
 * владелец руками (payments.md §1.1).
 */
export const TEST_PLAN_CODES = ['test_1'] as const;

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

export interface PlanBase {
  readonly code: PlanCode;
  /**
   * План существует только при `PAYMENTS_TEST_PLANS=1` и никогда не попадает
   * в каталог для клиента. Учёт тестовых платежей — `payments.is_test`.
   */
  readonly testOnly: boolean;
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
    testOnly: false,
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
    testOnly: false,
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
    testOnly: false,
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
    testOnly: false,
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
    testOnly: false,
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
    testOnly: false,
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
  /**
   * Тестовый тариф владельца: 1 ⭐ за неделю, права как у `month_399`.
   *
   * Неделя, а не месяц, — намеренно: если тестовую подписку забудут отменить,
   * следующее списание случится через неделю, и это ошибка за 1 ⭐, а не
   * повторный платёж, о котором узнают из жалобы. `subscriptionPlan` — `month`:
   * контракт `SubscriptionState.plan` не расширяется, «тестовость» живёт в
   * `plan_code` и в `payments.is_test`, а не в правах.
   */
  test_1: {
    code: 'test_1',
    testOnly: true,
    kind: 'subscription',
    subscriptionPlan: 'month',
    stars: 1,
    periodSeconds: 604800,
    grants: { fullForecast: true, askPerDay: 5, compatPerMonth: 1, solarIncluded: false },
    title: 'Тестовая подписка — 1 звезда',
    description: 'Неделя доступа за 1 ⭐. Только для проверки оплаты владельцем',
    priceLabel: 'Тест',
    sort: 90,
  },
} as const;

/**
 * Планы в порядке пейволла. Тестовые исключены всегда: это список для
 * клиента, а не каталог сервера (`ALL_PLAN_CODES` — для второго).
 */
export const PLANS_ORDERED: readonly Plan[] = Object.values(PLANS)
  .filter((plan) => !plan.testOnly)
  .sort((a, b) => a.sort - b.sort);

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
