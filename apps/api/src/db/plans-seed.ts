/**
 * Сид таблицы `plans` — **единственное место в репозитории, где записаны цены**.
 *
 * Здесь, а не в `packages/shared/src/plans.ts`: рантайм цены не читает из кода
 * вообще (итерация 23, дополнение). Файл лежит в `db/`, поэтому тест-страж
 * `plans-single-source.spec.ts` пропускает его так же, как миграции.
 *
 * Правила, которые держит сид:
 *   • вставляет только **отсутствующие** строки: правка цены владельцем через
 *     `pnpm plans:set-price` переживает любой повторный `db:seed` и деплой;
 *   • тексты и права дозаполняет только там, где они пустые (миграция 0025
 *     добавила колонки с пустыми значениями);
 *   • тестовые тарифы создаёт **только** при `PAYMENTS_TEST_PLANS=1` и никогда
 *     при `NODE_ENV=production`.
 */

import type { PlanCode, PlanGrants, PlanKind, SubscriptionPlan } from '@astro-soul/shared';

export interface PlanSeedRow {
  readonly code: PlanCode;
  readonly kind: PlanKind;
  readonly subscriptionPlan: SubscriptionPlan;
  /** Цена в звёздах. Меняется только `pnpm plans:set-price`. */
  readonly stars: number;
  readonly periodSeconds: number | null;
  /** Название тарифа для логов и админки; в счёт не уходит. */
  readonly title: string;
  /**
   * Название в окне оплаты Telegram: 1–32 символа (лимит Bot API, в БД `CHECK`).
   *
   * Отдельно от `title` и `paywallTitle` намеренно (итерация 26): правка
   * названия тарифа или витрины не должна ломать оплату, а лимит счёта —
   * ровно та ошибка, из-за которой три тарифа не продавались.
   */
  readonly invoiceTitle: string;
  readonly description: string;
  readonly priceLabel: string;
  readonly paywallTitle: string;
  readonly paywallSubtitle: string;
  readonly grants: PlanGrants;
  readonly sort: number;
  readonly testOnly: boolean;
}

/**
 * Восемь строк: шесть тарифов каталога и два тестовых. Формулировки и цены
 * перенесены из `packages/shared/src/plans.ts` без изменений (владелец их не
 * пересматривал в этой итерации).
 */
export const PLAN_SEED: readonly PlanSeedRow[] = [
  {
    code: 'one_149',
    kind: 'one_off',
    subscriptionPlan: 'none',
    stars: 149,
    periodSeconds: null,
    title: 'Разбор личности — полный разбор',
    invoiceTitle: 'Полный разбор',
    description: 'Шесть глав по вашей натальной карте и PDF',
    priceLabel: 'Разбор',
    paywallTitle: 'Полный разбор',
    paywallSubtitle: 'Все главы разбора по этой карте. Разовая покупка, без подписки.',
    grants: { grant: 'report' },
    sort: 10,
    testOnly: false,
  },
  {
    code: 'week_149',
    kind: 'subscription',
    subscriptionPlan: 'week',
    stars: 149,
    periodSeconds: 604_800,
    // В окно оплаты уходит `invoiceTitle` (лимит Bot API — 32 символа, есть
    // `CHECK` в БД). `title` — для логов, `paywallTitle` — для витрины.
    title: 'Разбор личности: неделя',
    invoiceTitle: 'Подписка на неделю',
    description: 'Ежедневный прогноз, 5 вопросов в день, совместимость 1 в месяц',
    priceLabel: 'Неделя',
    paywallTitle: 'Подписка на неделю',
    paywallSubtitle: 'Полные прогнозы, 5 вопросов карте в день и разбор пары — раз в месяц.',
    grants: { fullForecast: true, askPerDay: 5, compatPerMonth: 1, solarIncluded: false },
    sort: 20,
    testOnly: false,
  },
  {
    code: 'month_399',
    kind: 'subscription',
    subscriptionPlan: 'month',
    stars: 399,
    periodSeconds: 2_592_000,
    title: 'Разбор личности: месяц',
    invoiceTitle: 'Подписка на месяц',
    description: 'Ежедневный прогноз, 5 вопросов в день, совместимость 1 в месяц',
    priceLabel: 'Месяц',
    paywallTitle: 'Подписка на месяц',
    paywallSubtitle: 'Полные прогнозы, 5 вопросов карте в день и разбор пары — раз в месяц.',
    grants: { fullForecast: true, askPerDay: 5, compatPerMonth: 1, solarIncluded: false },
    sort: 30,
    testOnly: false,
  },
  {
    code: 'year_2990',
    kind: 'subscription',
    subscriptionPlan: 'year',
    stars: 2_990,
    periodSeconds: 31_536_000,
    title: 'Разбор личности: год',
    invoiceTitle: 'Подписка на год',
    description: 'Всё, что в месячной подписке, плюс карта года',
    priceLabel: 'Год',
    paywallTitle: 'Подписка на год',
    paywallSubtitle: 'Всё, что в подписке на месяц. Карта года появится в ближайшие дни.',
    grants: { fullForecast: true, askPerDay: 5, compatPerMonth: 1, solarIncluded: true },
    sort: 40,
    testOnly: false,
  },
  {
    code: 'compat_249',
    kind: 'one_off',
    subscriptionPlan: 'none',
    stars: 249,
    periodSeconds: null,
    title: 'Совместимость с партнёром',
    invoiceTitle: 'Совместимость с партнёром',
    description: 'Разбор пары по двум натальным картам',
    priceLabel: 'Совместимость',
    paywallTitle: 'Совместимость с партнёром',
    paywallSubtitle: 'Разбор пары по двум картам. Разовая покупка, без подписки.',
    grants: { grant: 'compat' },
    sort: 50,
    testOnly: false,
  },
  {
    code: 'solar_590',
    kind: 'one_off',
    subscriptionPlan: 'none',
    stars: 590,
    periodSeconds: null,
    title: 'Карта года',
    invoiceTitle: 'Карта года',
    description: 'Прогноз на год вперёд по солярной карте',
    priceLabel: 'Карта года',
    paywallTitle: 'Карта года',
    paywallSubtitle: 'Прогноз на год вперёд по солярной карте. Разовая покупка, без подписки.',
    grants: { grant: 'solar' },
    sort: 60,
    testOnly: false,
  },
  /**
   * Тестовая подписка за 1 ⭐, права как у `month_399`.
   *
   * Период — 30 дней, а не 7, как задумывалось сначала: Bot API принимает у
   * звёздных подписок только `subscription_period = 2 592 000`, и недельный
   * тестовый тариф вообще не выставлялся (итерация 25, `payments.md` §3.6).
   * Забытая тестовая подписка спишется через 30 дней за 1 ⭐ — это дешевле,
   * чем невозможность проверить путь оплаты.
   */
  {
    code: 'test_1',
    kind: 'subscription',
    subscriptionPlan: 'month',
    stars: 1,
    periodSeconds: 2_592_000,
    title: 'Тестовая подписка — 1 ⭐',
    invoiceTitle: 'Тестовая подписка — 1 ⭐',
    description: '30 дней доступа за 1 ⭐. Только для проверки оплаты владельцем',
    priceLabel: 'Тест',
    paywallTitle: 'Тестовая подписка',
    paywallSubtitle: '1 ⭐ за 30 дней доступа, права как у месячной. Только для проверки оплаты.',
    grants: { fullForecast: true, askPerDay: 5, compatPerMonth: 1, solarIncluded: false },
    sort: 90,
    testOnly: true,
  },
  /** Тестовый разовый разбор: без `subscription_period`, иначе это была бы подписка. */
  {
    code: 'test_report_1',
    kind: 'one_off',
    subscriptionPlan: 'none',
    stars: 1,
    periodSeconds: null,
    title: 'Тестовый разбор — 1 ⭐',
    invoiceTitle: 'Тестовый разбор — 1 ⭐',
    description: 'Разбор личности за 1 ⭐ для одной карты. Только для проверки оплаты',
    priceLabel: 'Тест-разбор',
    paywallTitle: 'Тестовый разбор',
    paywallSubtitle: '1 ⭐ за полный разбор одной карты. Только для проверки оплаты.',
    grants: { grant: 'report' },
    sort: 91,
    testOnly: true,
  },
];

/**
 * Можно ли создавать тестовые строки в этой базе.
 *
 * Два условия: база не прод (по `NODE_ENV`) и флаг включён. Владелец включает
 * флаг на стенде — строки появляются; в проде их не будет ни при каком флаге,
 * а `check.sh --prod` дополнительно падает, если они там всё-таки есть.
 */
export function testPlansAllowed(
  env: { readonly NODE_ENV?: string | undefined },
  flag: boolean,
): boolean {
  return flag && env.NODE_ENV !== 'production';
}
