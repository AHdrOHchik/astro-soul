import type { PlanKind } from '@astro-soul/shared';
import type { PlanRow } from './plans.repository';

/**
 * Витрина `GET /billing/plans`: что продаётся, за сколько и что это даёт.
 *
 * Итерация 23 (дополнение): **сумм здесь нет**. Цена, тексты и права приходят
 * строкой из `plans` (`plans.repository.ts`), этот файл только раскладывает их
 * в форму контракта и собирает `includes[]` из прав плана. Раньше `stars` и
 * `testOnly` брались из `packages/shared/src/plans.ts` — то есть из второго
 * каталога, и правка цены в БД на витрину не влияла.
 *
 * Границы, которые держатся:
 *   • каталог — строки `is_active AND NOT test_only`;
 *   • тестовые добавляются **только** при `PAYMENTS_TEST_PLANS=1` и только
 *     с `test: true` — ни серыми, ни скрытыми полями при выключенном флаге их
 *     нет в ответе вообще;
 *   • `plan_code` — строка, а не контрактный `PlanCode`: перечисление
 *     контракта остаётся закрытым каталогом, а не зависит от окружения.
 */

export interface PlanOffer {
  readonly plan_code: string;
  readonly kind: PlanKind;
  readonly stars: number;
  readonly period_sec: number | null;
  readonly title: string;
  readonly subtitle: string;
  readonly includes: readonly string[];
  readonly test: boolean;
}

/** «5 вопросов карте в день» — числительное согласуется, а не «5 вопроса». */
function questionsPerDay(count: number): string {
  const tail = count % 100;
  const last = count % 10;
  const word =
    tail >= 11 && tail <= 14 ? 'вопросов' : last === 1 ? 'вопрос' : last >= 2 && last <= 4 ? 'вопроса' : 'вопросов';

  return `${count} ${word} карте в день`;
}

/**
 * Что даёт план — из его прав в `plans.grants`, а не из текста рядом.
 *
 * Обещание берётся из тех же прав, по которым сервер выдаёт доступ, поэтому
 * выпущенное и «обещанное» не смешиваются: обещания живут в
 * `paywall_subtitle` и явно говорят «появится в ближайшие дни».
 */
function includesOf(plan: PlanRow): readonly string[] {
  if (plan.kind === 'subscription') {
    const items: string[] = [];
    if (plan.grants.fullForecast) items.push('Полные прогнозы каждый день');
    if (plan.grants.askPerDay > 0) items.push(questionsPerDay(plan.grants.askPerDay));
    if (plan.grants.compatPerMonth > 0) items.push('Совместимость раз в месяц');
    if (plan.grants.solarIncluded) items.push('Карта года');

    return items;
  }

  switch (plan.grant) {
    case 'report':
      return ['Все главы разбора по этой карте', 'PDF-файл'];
    case 'compat':
      return ['Разбор пары по двум картам', 'PDF-файл'];
    case 'solar':
      return ['Прогноз на год вперёд', 'PDF-файл'];
  }
}

export function offerOf(plan: PlanRow): PlanOffer {
  return {
    plan_code: plan.code,
    kind: plan.kind,
    // Цена — из строки `plans`, прочитанной на этот запрос: правка в БД
    // действует сразу, без перезапуска API.
    stars: plan.stars,
    // Для разового товара период — `null`, а не «нет поля»: клиенту нужно
    // отличать «без периода» от «сервер не сказал».
    period_sec: plan.kind === 'subscription' ? plan.periodSeconds : null,
    title: plan.paywallTitle,
    subtitle: plan.paywallSubtitle,
    includes: includesOf(plan),
    test: plan.testOnly,
  };
}

/**
 * Витрина для клиента. Фильтрация тестовых — в SQL резолвера и здесь:
 * при `includeTestPlans = false` в массиве нет ни одного тестового кода, и
 * вызывающий код не может «забыть отфильтровать».
 */
export function planOffers(rows: readonly PlanRow[]): readonly PlanOffer[] {
  return rows.map(offerOf);
}
