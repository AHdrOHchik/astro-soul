import type { Plan } from './plans';

/**
 * Результат `getEntitlements(userId)` — единственного места, где решается,
 * что можно пользователю (payments.md §4). Никаких `if (plan === 'month')`
 * в обработчиках быть не должно.
 */
export interface Entitlements {
  /** Подписка действует прямо сейчас. */
  readonly isActive: boolean;
  readonly plan: 'none' | 'trial' | 'week' | 'month' | 'year';
  /** Полные прогнозы (иначе — короткая бесплатная версия). */
  readonly fullForecast: boolean;
  /** Вопросов «спроси карту» в день: 0 / 1 / 5 / -1. */
  readonly askPerDay: number;
  /** Куплен ли полный разбор (разово, навсегда для карты). */
  readonly fullReport: boolean;
  /** Совместимостей в месяц. */
  readonly compatPerMonth: number;
  /** Карта года включена в подписку. */
  readonly solarIncluded: boolean;
}

/** Пользователь без подписки и без разовых покупок. */
export const FREE_ENTITLEMENTS: Entitlements = {
  isActive: false,
  plan: 'none',
  fullForecast: false,
  askPerDay: 1,
  fullReport: false,
  compatPerMonth: 0,
  solarIncluded: false,
};

export function entitlementsForPlan(plan: Plan): Entitlements {
  if (plan.kind === 'one_off') {
    return {
      ...FREE_ENTITLEMENTS,
      fullReport: plan.grant === 'report',
      compatPerMonth: plan.grant === 'compat' ? 1 : 0,
      solarIncluded: plan.grant === 'solar',
    };
  }

  return {
    isActive: true,
    plan: plan.subscriptionPlan,
    fullForecast: plan.grants.fullForecast,
    askPerDay: plan.grants.askPerDay,
    fullReport: false,
    compatPerMonth: plan.grants.compatPerMonth,
    solarIncluded: plan.grants.solarIncluded,
  };
}
