import type { PlanRightsSource } from './plans.js';

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
  /**
   * Карта, за которую оплачен полный разбор; `null` — оплаченного нет.
   * Производное от `fullReport`: сам флаг остаётся «у пользователя есть
   * оплаченный разбор», а привязка к карте живёт здесь (контракт 1.5.4).
   */
  readonly fullReportChartId: string | null;
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
  fullReportChartId: null,
  compatPerMonth: 0,
  solarIncluded: false,
};

/**
 * Права из плана. Вход — структурный `PlanRightsSource`, а не каталог из
 * `plans.ts`: с итерации 23 права читаются из таблицы `plans` (колонка
 * `grants`), поэтому функция не знает, откуда именно пришла строка.
 */
export function entitlementsForPlan(plan: PlanRightsSource): Entitlements {
  if (plan.kind === 'one_off') {
    return {
      ...FREE_ENTITLEMENTS,
      fullReport: plan.grant === 'report',
      fullReportChartId: null,
      compatPerMonth: plan.grant === 'compat' ? 1 : 0,
      solarIncluded: plan.grant === 'solar',
    };
  }

  const grants = plan.grants ?? { fullForecast: false, askPerDay: 0, compatPerMonth: 0, solarIncluded: false };

  return {
    isActive: true,
    plan: plan.subscriptionPlan,
    fullForecast: grants.fullForecast,
    askPerDay: grants.askPerDay,
    fullReport: false,
    fullReportChartId: null,
    compatPerMonth: grants.compatPerMonth,
    solarIncluded: grants.solarIncluded,
  };
}

/**
 * Источник бесплатного права (контракт 1.6.14).
 *
 * `partner` — партнёрский код, `founder` — «первые 50», `referral` — друг
 * пригласил, `admin` — ручная выдача. Платёж не участвует ни в одном из них:
 * грант — это право по обстоятельству, а не покупка.
 */
export type GrantSource = 'partner' | 'founder' | 'referral' | 'admin';

/** Что именно даёт право. */
export type GrantKind = 'all_access' | 'single_report' | 'single_compat';

/**
 * Бесплатный доступ по праву — отдельный блок `Me.entitlements` (1.6.14).
 *
 * Отдельный от `Entitlements`, а не поля внутри: `Entitlements` — форма прав,
 * из которой считается квота, и она не должна зависеть от того, откуда право
 * взялось. Клиент рисует «открыто до 14 декабря» по `allAccessUntil` и не
 * решает доступ сам — сервер всё равно проверяет `hasAccess`.
 */
export interface GrantEntitlements {
  /** До какого момента действует «всё включено»; `null` — такого права нет. */
  readonly allAccessUntil: string | null;
  /** Откуда последнее действующее право; `null` — прав нет. */
  readonly source: GrantSource | null;
  /** Неизрасходованных бесплатных разборов. */
  readonly singleReports: number;
  /** Неизрасходованных бесплатных совместимостей. */
  readonly singleCompat: number;
  /** Человек в списке первых 50. */
  readonly isFounder: boolean;
  /** Номер места основателя (1..50); `null` — не основатель. */
  readonly founderPlace: number | null;
}

/** Прав нет: пользователь без кодов, приглашений и места в «первых 50». */
export const EMPTY_GRANT_ENTITLEMENTS: GrantEntitlements = {
  allAccessUntil: null,
  source: null,
  singleReports: 0,
  singleCompat: 0,
  isFounder: false,
  founderPlace: null,
};
