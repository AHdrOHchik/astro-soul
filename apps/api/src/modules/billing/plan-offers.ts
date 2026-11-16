import { PLANS, PLANS_ORDERED, TEST_PLAN_CODES, type Plan } from '@astro-soul/shared';

/**
 * Витрина `GET /billing/plans`: что продаётся, за сколько и что это даёт.
 *
 * До 1.5.9 этот список знал клиент (`apps/web/src/lib/plans.ts`): цены там
 * были ссылкой на общую таблицу, но сам набор — хардкодом. Из-за этого ни
 * тестовый тариф нельзя было показать, не правя фронт, ни цену изменить без
 * релиза клиента. Теперь набор, цены, периоды и тексты отдаёт сервер, а
 * клиент рисует то, что получил.
 *
 * Границы, которые здесь держатся:
 *   • каталог — `PLANS_ORDERED`, то есть шесть обычных тарифов в порядке
 *     пейволла; тестовые в него не входят никогда;
 *   • тестовые добавляются **только** при `PAYMENTS_TEST_PLANS=1` и только
 *     с `test: true` — ни серыми, ни скрытыми полями при выключенном флаге
 *     их нет в ответе вообще;
 *   • `plan_code` — строка, а не контрактный `PlanCode`: перечисление
 *     контракта остаётся закрытым каталогом, а не зависит от окружения.
 */

export interface PlanOffer {
  readonly plan_code: string;
  readonly kind: Plan['kind'];
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
 * Что даёт план — из его же прав, а не из текста рядом.
 *
 * Обещание берётся из `grants`/`grant`, поэтому выпущенное и «обещанное»
 * не смешиваются: здесь только то, что сервер действительно выдаёт по этому
 * тарифу. Формулировки, обещающие больше, живут в `paywallSubtitle` и явно
 * говорят «появится в ближайшие дни».
 */
function includesOf(plan: Plan): readonly string[] {
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

export function offerOf(plan: Plan): PlanOffer {
  return {
    plan_code: plan.code,
    kind: plan.kind,
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
 * Витрина для клиента. `testPlansEnabled` — единственный вход флага:
 * при `false` в массиве нет ни одного тестового кода, и вызывающий код не
 * может «забыть отфильтровать» — фильтрация здесь.
 */
export function planOffers(testPlansEnabled: boolean): readonly PlanOffer[] {
  const catalogue = PLANS_ORDERED.map(offerOf);
  if (!testPlansEnabled) return catalogue;

  // Тестовые — после каталога и в своём порядке: клиент рисует их отдельным
  // блоком «Тестовые» ниже обычных, а не подмешивает к продаже.
  return [...catalogue, ...TEST_PLAN_CODES.map((code) => offerOf(PLANS[code]))];
}
