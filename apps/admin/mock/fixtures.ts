/*
 * Данные dev-мокера. Это НЕ часть продукта: файл импортирует только
 * `vite.config.ts` (узел сборки), в клиентский бандл он не попадает физически, а
 * `scripts/check-no-mock.mjs` проверяет это по артефакту сборки, а не на слово.
 *
 * Три правила:
 *   1. Всё типизировано сгенерированными из контракта типами: мок не может
 *      разойтись с `api.openapi.yaml` — `pnpm typecheck` не даст.
 *   2. Данные вымышленные и **неудобные** намеренно: `degraded`, исчерпанный
 *      бюджет, молчащий планировщик, просроченные и отозванные права. Тревожные
 *      состояния — те, ради которых панель и делается, и их надо видеть.
 *   3. Ни одного реального идентификатора: `user_id` — uuid из воздуха, telegram
 *      id — `777001`.
 */

import type { components, paths } from '../src/api/schema.gen';
import type { AdminPlanHistoryRow, AdminPlanRow, AdminUserCard, AdminUserRow, AuditEntry } from '../src/api/types.ts';

/** Маркер для стража: если строка попала в `dist` — мок уехал в прод. */
export const MOCK_MARKER = 'ADMIN_MOCK_FIXTURE_v1';

type Schemas = components['schemas'];
export type MockAccessCode = Schemas['AccessCode'];
export type MockAlerts = paths['/api/v1/admin/alerts']['get']['responses'][200]['content']['application/json'];
export type MockMetrics = paths['/api/v1/admin/metrics']['get']['responses'][200]['content']['application/json'];
export type MockGrant = paths['/api/v1/admin/grants']['get']['responses'][200]['content']['application/json']['items'][number];

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

/** Всё считается от «сейчас», чтобы «молчит N часов» и «истёк» не протухали. */
export function nowIso(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

/** Тот самый человек, ради которого и заведена панель. */
export const DEMO_USER_ID = '2b1f7a04-9d3c-4e21-8a55-000000000001';
export const DEMO_CSRF = 'demo-csrf-token-1';
export const DEMO_COOKIE = 'admin_session=mock';

export const mockMe = {
  tg_id: '777001',
  name: 'ДЕМО · данные вымышлены',
  // Ровно 12 часов: столько живёт боевая сессия (ТЗ §3), и в ДЕМО-режиме
  // панель должна вести себя так же — в том числе у границы срока.
  expires_at: nowIso(12 * HOUR),
  csrf_token: DEMO_CSRF,
};

/**
 * Алерты: четыре сработавших, один нет — на нём видно, что панель фильтрует, а
 * не рисует всё подряд.
 */
export const mockAlerts: MockAlerts = {
  checked_at: nowIso(-4 * MINUTE),
  alerts: [
    {
      id: 'payment_not_arriving',
      level: 'critical',
      value: 3,
      threshold: 0,
      since: nowIso(-5 * HOUR),
      fired: true,
      // 1.6.17: алерт можно заглушить до срока — в ДЕМО показываем «не заглушен»,
      // а сам экран рисует «скрыт до HH:MM» по этому полю.
      acked_until: null,
    },
    {
      id: 'telegram_webhook',
      level: 'critical',
      value: 47,
      threshold: 10,
      since: nowIso(-47 * MINUTE),
      fired: true,
      acked_until: null,
    },
    {
      id: 'backup_stale',
      level: 'warning',
      value: 92,
      threshold: 36,
      since: nowIso(-56 * HOUR),
      fired: true,
      acked_until: null,
    },
    {
      id: 'llm_spend',
      level: 'warning',
      value: 780,
      threshold: 500,
      since: nowIso(-9 * HOUR),
      fired: true,
      acked_until: null,
    },
    {
      id: 'generations_failing',
      level: 'warning',
      value: 2,
      threshold: 5,
      since: null,
      fired: false,
      acked_until: null,
    },
  ],
};

/**
 * Метрики: картинка «вечер пятницы, всё немного сломалось». Бюджет бесплатно
 * доступа выбран на 94%, планировщик молчит сутки, провалы генераций идут
 * серией, которая держит брейкер открытым.
 */
export const mockMetrics: MockMetrics = {
  mau: 412,
  paying: 9,
  conversion_to_paid: 0.022,
  churn_30d: 0.111,
  stars_received_30d: 1840,
  llm_cost_rub_30d: 142.85,
  reports_failed_30d: 17,
  reports_validation_streak: 4,
  reports_breaker_open: true,
  reports_breaker_last_failed_at: nowIso(-40 * MINUTE),
  payments_rejected_30d: 3,
  amount_mismatch_30d: 2,
  refunded_30d: 5,
  pending_payments_now: 1,
  pre_checkout_total_24h: 12,
  pre_checkout_rejected_24h: 3,
  pre_checkout_timeout_24h: 1,
  successful_payment_total_24h: 9,
  payment_failed_24h: 3,
  telegram_webhook_ok: false,
  telegram_webhook_checked_at: nowIso(-47 * MINUTE),
  test_plans_active: false,
  test_payments_30d: 0,
  subscription_cancel_failed_30d: 1,
  subscriptions_cancelled_pending_telegram: 0,
  subscription_cancel_total_24h: 2,
  subscription_cancel_failed_24h: 0,
  subscription_cancel_no_charge_id_24h: 0,
  subscriptions_auto_renew_off: 4,
  events_30d: { app_open: 1840, chart_created: 512, payment_succeeded: 21 },
  funnel_30d: { app_open: 402, consent_accepted: 361, chart_created: 288, checkout_opened: 41, payment_succeeded: 9 },
  forecast_ready_24h: 96,
  forecast_failed_24h: 2,
  forecast_facts_only_24h: 44,
  forecast_cache_hits_24h: 18,
  forecast_cost_rub_24h: 41.2,
  compat_failed_24h: 3,
  compat_cost_rub_24h: 9.1,
  questions_ready_24h: 22,
  questions_failed_24h: 1,
  questions_refused_24h: 4,
  questions_refused_by_reason: { off_topic: 3, no_chart: 1 },
  questions_cost_rub_24h: 12.6,
  question_p95_ms: 4210,
  share_cards_created_24h: { day: 4, wheel: 0, insight: 1, identity: 2, moon: 0 },
  push_sent_24h: 0,
  push_failed_24h: 31,
  push_skipped_no_tz_24h: 17,
  push_duplicate_prevented_24h: 2,
  push_claimed_not_sent_24h: 7,
  grants_active: 23,
  grants_issued_24h: { partner: 2, founder: 1 },
  grants_revenue_lost_rub_24h: 233.33,
  codes_activated_24h: 2,
  referrals_joined_24h: 0,
  referrals_rewarded_24h: 0,
  founders_taken: 47,
  bonus_budget_spent_rub: 9400,
  bonus_budget_limit_rub: 10000,
};

export const mockCodes: MockAccessCode[] = [
  {
    id: '0d0e3b6f-1c2d-4a5b-8c9d-000000000001',
    code: 'K7M2P9X4',
    kind: 'all_access',
    days: 30,
    max_activations: 10,
    activations: 3,
    partner_name: 'ДЕМО · подкаст «Небо»',
    is_active: true,
    expires_at: nowIso(14 * DAY),
    created_at: nowIso(-3 * DAY),
  },
  {
    id: '0d0e3b6f-1c2d-4a5b-8c9d-000000000002',
    code: 'QWERTY23',
    kind: 'all_access',
    days: 7,
    max_activations: 5,
    activations: 5,
    partner_name: 'ДЕМО · рассылка',
    is_active: true,
    expires_at: nowIso(4 * DAY),
    created_at: nowIso(-9 * DAY),
  },
  {
    id: '0d0e3b6f-1c2d-4a5b-8c9d-000000000003',
    code: 'ZXCVBN12',
    kind: 'single_report',
    days: null,
    max_activations: 1,
    activations: 0,
    partner_name: null,
    is_active: false,
    expires_at: nowIso(-2 * DAY),
    created_at: nowIso(-20 * DAY),
  },
  {
    id: '0d0e3b6f-1c2d-4a5b-8c9d-000000000004',
    code: 'AAAA1111',
    kind: 'single_compat',
    days: null,
    max_activations: 100,
    activations: 12,
    partner_name: 'ДЕМО · партнёр с истёкшим сроком',
    is_active: true,
    expires_at: nowIso(-1 * DAY),
    created_at: nowIso(-40 * DAY),
  },
];

export const mockGrants: MockGrant[] = [
  {
    id: '5a1b2c3d-0000-4000-8000-000000000001',
    user_id: DEMO_USER_ID,
    kind: 'all_access',
    source: 'founder',
    code_id: null,
    days: 30,
    starts_at: nowIso(-5 * DAY),
    expires_at: nowIso(25 * DAY),
    consumed_at: null,
    revoked_at: null,
    revoked: false,
    created_at: nowIso(-5 * DAY),
  },
  {
    id: '5a1b2c3d-0000-4000-8000-000000000002',
    user_id: DEMO_USER_ID,
    kind: 'all_access',
    source: 'partner',
    code_id: '0d0e3b6f-1c2d-4a5b-8c9d-000000000001',
    days: 7,
    starts_at: nowIso(-30 * DAY),
    expires_at: nowIso(-23 * DAY),
    consumed_at: null,
    revoked_at: null,
    revoked: false,
    created_at: nowIso(-30 * DAY),
  },
  {
    id: '5a1b2c3d-0000-4000-8000-000000000003',
    user_id: DEMO_USER_ID,
    kind: 'single_report',
    source: 'purchase',
    code_id: null,
    days: null,
    starts_at: nowIso(-2 * DAY),
    expires_at: null,
    consumed_at: nowIso(-1 * DAY),
    revoked_at: null,
    revoked: false,
    created_at: nowIso(-2 * DAY),
  },
  {
    id: '5a1b2c3d-0000-4000-8000-000000000004',
    user_id: DEMO_USER_ID,
    kind: 'all_access',
    source: 'admin',
    code_id: null,
    days: 14,
    starts_at: nowIso(-60 * DAY),
    expires_at: nowIso(-46 * DAY),
    consumed_at: null,
    revoked_at: nowIso(-50 * DAY),
    revoked: true,
    created_at: nowIso(-60 * DAY),
  },
];


/* ------------------------------------------------------------------------- *
 * «Тарифы» и «Пользователи» — данные для экранов итерации 2.
 *
 * Формы взяты из ответов владельца (`answers/admin-pr1-review.md`), и мокер
 * намеренно ведёт себя как сервер, а не как «удобная заглушка»:
 *   • `PATCH /admin/plans/{code}` требует `comment` и сверяет `base_version`
 *     (на расхождении — 409 `price_changed` с текущим значением);
 *   • `founder_month` не редактируется вовсе (403 `founder_plan_locked`);
 *   • возврат только полный: сумма живёт в `refundable`, отдельного ввода нет,
 *     после возврата `refundable` становится `null`.
 * ------------------------------------------------------------------------- */

export const mockPlans: AdminPlanRow[] = [
  {
    code: 'week_149',
    title: 'Неделя',
    price_stars: 149,
    discount_price_stars: null,
    is_active: true,
    test_only: false,
    founder_only: false,
    price_change_scope: 'only_new_purchases',
    version: 3,
    updated_at: nowIso(-9 * DAY),
    updated_by_name: 'Владелец',
    updated_by_tg_id: '777001',
  },
  {
    code: 'month_399',
    title: 'Месяц',
    price_stars: 399,
    discount_price_stars: null,
    is_active: true,
    test_only: false,
    founder_only: false,
    price_change_scope: 'only_new_purchases',
    version: 7,
    updated_at: nowIso(-2 * DAY),
    updated_by_name: 'Владелец',
    updated_by_tg_id: '777001',
  },
  {
    code: 'year_2990',
    title: 'Год',
    price_stars: 2990,
    discount_price_stars: 2490,
    is_active: true,
    test_only: false,
    founder_only: false,
    price_change_scope: 'only_new_purchases',
    version: 11,
    updated_at: nowIso(-30 * MINUTE),
    updated_by_name: 'Поддержка',
    updated_by_tg_id: '777002',
  },
  {
    code: 'one_149',
    title: 'Один разбор',
    price_stars: 149,
    discount_price_stars: null,
    is_active: true,
    test_only: false,
    founder_only: false,
    price_change_scope: 'only_new_purchases',
    version: 1,
    updated_at: nowIso(-40 * DAY),
    updated_by_name: null,
    updated_by_tg_id: null,
  },
  {
    // Право проверяет сервер по таблице `founders`; в витрине тарифа нет —
    // и `price_change_scope` у него пустой: панель обязана сказать
    // «сервер не назвал правило», а не придумать формулировку.
    code: 'founder_month',
    title: 'Основательский',
    price_stars: 250,
    discount_price_stars: null,
    is_active: true,
    test_only: false,
    founder_only: true,
    price_change_scope: '',
    version: 2,
    updated_at: nowIso(-60 * DAY),
    updated_by_name: 'Владелец',
    updated_by_tg_id: '777001',
  },
  {
    code: 'test_1',
    title: 'Тестовый',
    price_stars: 1,
    discount_price_stars: null,
    is_active: false,
    test_only: true,
    founder_only: false,
    price_change_scope: 'only_new_purchases',
    version: 1,
    updated_at: nowIso(-3 * DAY),
    updated_by_name: 'Поддержка',
    updated_by_tg_id: '777002',
  },
];

export const mockPlanHistory: readonly (AdminPlanHistoryRow & { code: string })[] = [
  {
    code: 'month_399',
    at: nowIso(-2 * DAY),
    actor_tg_id: '777001',
    // Снимок имени на момент действия — не ссылка на `users`.
    actor_name: 'Владелец',
    from_price: 449,
    to_price: 399,
    comment: 'прайс перед новогодним пушем',
  },
  {
    code: 'month_399',
    at: nowIso(-45 * DAY),
    actor_tg_id: '777002',
    actor_name: 'Поддержка',
    from_price: null,
    to_price: 449,
    comment: 'создание тарифа',
  },
];

/** Полная карточка: строка поиска выводится из неё, а не живёт отдельно. */
export const mockUsers: AdminUserCard[] = [
  {
    user_id: DEMO_USER_ID,
    tg_id: '777003',
    alias: 'anna_chart',
    name: 'Анна (вымышленная)',
    created_at: nowIso(-120 * DAY),
    last_seen_at: nowIso(-3 * HOUR),
    push_enabled: true,
    banned_at: null,
    ban_reason: null,
    subscription: { plan_code: 'month_399', until: nowIso(21 * DAY), source: 'payment' },
    payments: [
      { id: 'pay-1', charge_id: 'chg_9001', kind: 'payment', stars: 399, at: nowIso(-9 * DAY), refunded: false },
      { id: 'pay-2', charge_id: 'chg_8100', kind: 'payment', stars: 399, at: nowIso(-39 * DAY), refunded: true },
      { id: 'pay-3', charge_id: 'chg_8100r', kind: 'refund', stars: 399, at: nowIso(-38 * DAY), refunded: false },
    ],
    refundable: { charge_id: 'chg_9001', amount_stars: 399, currency: 'XTR' },
  },
  {
    user_id: '2b1f7a04-9d3c-4e21-8a55-000000000002',
    tg_id: '777004',
    alias: 'banned_ivan',
    name: 'Иван (вымышленный)',
    created_at: nowIso(-300 * DAY),
    last_seen_at: nowIso(-40 * DAY),
    push_enabled: false,
    banned_at: nowIso(-10 * DAY),
    ban_reason: 'массовые промпты-спамы в генерации',
    subscription: null,
    payments: [],
    refundable: null,
  },
  {
    user_id: '2b1f7a04-9d3c-4e21-8a55-000000000003',
    tg_id: '777005',
    alias: null,
    name: 'Мария (вымышленная)',
    created_at: nowIso(-14 * DAY),
    last_seen_at: null,
    push_enabled: true,
    banned_at: null,
    ban_reason: null,
    subscription: null,
    payments: [{ id: 'pay-9', charge_id: 'chg_9500', kind: 'payment', stars: 149, at: nowIso(-13 * DAY), refunded: false }],
    refundable: { charge_id: 'chg_9500', amount_stars: 149, currency: 'XTR' },
  },
];

export function userRow(card: AdminUserCard): AdminUserRow {
  return {
    user_id: card.user_id,
    tg_id: card.tg_id,
    alias: card.alias,
    name: card.name,
    plan_code: card.subscription?.plan_code ?? null,
    access_until: card.subscription?.until ?? null,
    banned: card.banned_at !== null,
  };
}


/**
 * Журнал аудита. Порядок — как у серверной ленты (`at DESC`): самые свежие
 * первыми. Один `actor_tg_id = '0'` — служебная запись уборки: по ней видно,
 * что панель отличает «сервис» от человека, и `actor_name` здесь тоже снимок:
 * имена в `users` меняются, журнал — нет.
 */
export const mockAudit: AuditEntry[] = [
  {
    id: 'a-8',
    at: nowIso(-9 * MINUTE),
    actor_tg_id: '777001',
    actor_name: 'ДЕМО · данные вымышлены',
    action: 'code.create',
    entity: 'code',
    entity_id: 'c-42',
    before: null,
    after: { kind: 'single_report', days: 30, max_activations: 5 },
    reason: 'подкаст «Разбор», партия к запуску',
    request_id: 'req-1001',
  },
  {
    id: 'a-7',
    at: nowIso(-40 * MINUTE),
    actor_tg_id: '777001',
    actor_name: 'ДЕМО · данные вымышлены',
    action: 'session.login',
    entity: 'session',
    entity_id: null,
    before: null,
    after: null,
    reason: null,
    request_id: 'req-991',
  },
  {
    id: 'a-6',
    at: nowIso(-3 * HOUR),
    actor_tg_id: '777002',
    actor_name: 'Поддержка',
    action: 'grant.revoke',
    entity: 'grant',
    entity_id: 'g-17',
    before: { expires_at: nowIso(11 * DAY) },
    after: { revoked_at: nowIso(-3 * HOUR) },
    reason: 'право выдано ошибочно (дубль обращения 4170)',
    request_id: 'req-940',
  },
  {
    id: 'a-5',
    at: nowIso(-6 * HOUR),
    actor_tg_id: '0',
    actor_name: 'planner',
    action: 'session.purge',
    entity: 'session',
    entity_id: null,
    before: null,
    after: { purged: 3 },
    reason: null,
    request_id: null,
  },
  {
    id: 'a-4',
    at: nowIso(-2 * DAY),
    actor_tg_id: '777002',
    actor_name: 'Поддержка',
    action: 'grant.create',
    entity: 'grant',
    entity_id: 'g-15',
    before: null,
    after: { kind: 'all_access', days: 14 },
    reason: 'компенсация за сбой генерации 12.11',
    request_id: 'req-811',
  },
  {
    id: 'a-3',
    at: nowIso(-4 * DAY),
    actor_tg_id: '777001',
    actor_name: 'Владелец',
    action: 'code.revoke',
    entity: 'code',
    entity_id: 'c-31',
    before: { is_active: true },
    after: { is_active: false },
    reason: 'партнёр слил код в открытый чат',
    request_id: 'req-702',
  },
];
