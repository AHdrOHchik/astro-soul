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
import type {
  AdminFounder,
  AdminPartner,
  AdminPaymentEntry,
  AdminPlan,
  AdminPlanHistoryEntry,
  AdminReportSummary,
  AdminUserCard,
  AdminUserSummary,
  AuditEntry,
} from '../src/api/types.ts';

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

/**
 * Каталог тарифов — ровно `AdminPlan` из 1.6.16: `price_stars`, `test_only`,
 * `active`, `founder_only`, `version`, `updated_at`. Скидок, `is_active` и
 * «кто менял» в строке каталога нет — и в моке тоже, иначе экран привык бы к
 * полям, которых сервер не отдаёт.
 */
export const mockPlans: AdminPlan[] = [
  {
    code: 'week_149',
    kind: 'subscription',
    title: 'Неделя',
    price_stars: 149,
    period_days: 7,
    test_only: false,
    active: true,
    founder_only: false,
    version: 3,
    updated_at: nowIso(-9 * DAY),
  },
  {
    code: 'month_399',
    kind: 'subscription',
    title: 'Месяц',
    price_stars: 399,
    period_days: 30,
    test_only: false,
    active: true,
    founder_only: false,
    version: 7,
    updated_at: nowIso(-2 * DAY),
  },
  {
    code: 'year_2990',
    kind: 'subscription',
    title: 'Год',
    price_stars: 2990,
    period_days: 365,
    test_only: false,
    active: true,
    founder_only: false,
    version: 11,
    updated_at: nowIso(-30 * MINUTE),
  },
  {
    // Разовый разбор: `period_days` у него отсутствует — экран обязан показать
    // «—», а не 0 дней.
    code: 'one_149',
    kind: 'one_off',
    title: 'Один разбор',
    price_stars: 149,
    test_only: false,
    active: true,
    founder_only: false,
    version: 1,
    updated_at: nowIso(-40 * DAY),
  },
  {
    // Право проверяет сервер по таблице `founders`: цена обещана первым 50 и
    // из панели не меняется (`403 founder_plan_locked`).
    code: 'founder_month',
    kind: 'subscription',
    title: 'Основательский',
    price_stars: 250,
    period_days: 30,
    test_only: false,
    active: true,
    founder_only: true,
    version: 2,
    updated_at: nowIso(-60 * DAY),
  },
  {
    code: 'test_1',
    kind: 'one_off',
    title: 'Тестовый',
    price_stars: 1,
    test_only: true,
    active: false,
    founder_only: false,
    version: 1,
    updated_at: nowIso(-3 * DAY),
  },
];

/**
 * История цены — `AdminPlanHistoryEntry`. У самой первой записи
 * `previous_price_stars` нет: это «не было прежней цены», а не 0 ⭐.
 */
export const mockPlanHistory: AdminPlanHistoryEntry[] = [
  {
    id: 'ph-3',
    plan_code: 'month_399',
    price_stars: 399,
    previous_price_stars: 449,
    version: 7,
    comment: 'прайс перед новогодним пушем',
    actor_tg_id: '777001',
    // Снимок имени на момент действия — не ссылка на `users`.
    actor_name: 'Владелец',
    effective_from: nowIso(-2 * DAY),
    created_at: nowIso(-2 * DAY - 5 * MINUTE),
  },
  {
    id: 'ph-1',
    plan_code: 'month_399',
    price_stars: 449,
    previous_price_stars: null,
    version: 1,
    comment: 'создание тарифа',
    actor_tg_id: '777002',
    actor_name: 'Поддержка',
    effective_from: nowIso(-45 * DAY),
    created_at: nowIso(-45 * DAY),
  },
  {
    id: 'ph-2',
    plan_code: 'founder_month',
    price_stars: 250,
    previous_price_stars: null,
    version: 2,
    comment: 'обещание первым 50: цена зафиксирована, из панели не правится',
    actor_tg_id: '777001',
    actor_name: 'Владелец',
    effective_from: nowIso(-60 * DAY),
    created_at: nowIso(-60 * DAY),
  },
];

/** Срез карточки под строку поиска — `AdminUserSummary`, без ПДн. */
export function userSummary(card: AdminUserCard): AdminUserSummary {
  return {
    user_id: card.user_id,
    alias: card.alias,
    has_subscription: card.subscription?.is_active === true,
    subscription_plan: card.subscription?.plan ?? null,
    subscription_expires_at: card.subscription?.expires_at ?? null,
    banned: card.banned,
    created_at: card.created_at,
    last_seen_at: card.last_seen_at ?? null,
  };
}

/**
 * Карточки людей. Три состояния, ради которых экран и нужен: человек с
 * оплаченным зарядом (возврат возможен), заблокированный (без платежей
 * вовсе) и новичок с одним разовым платежом. `telegram_id` — только здесь, в
 * списке поиска его нет намеренно.
 */
export const mockUsers: AdminUserCard[] = [
  {
    user_id: DEMO_USER_ID,
    alias: 'anna_chart',
    created_at: nowIso(-120 * DAY),
    last_seen_at: nowIso(-3 * HOUR),
    telegram_id: '777003',
    push_enabled: true,
    banned: false,
    profile: {
      birth_date: '1991-04-17',
      birth_time: '07:40',
      time_precision: 'exact',
      place_name: 'Тверь',
      place_region: 'Тверская область',
      place_country: 'Россия',
      place_tz: 'Europe/Moscow',
    },
    chart: {
      chart_id: '0f0c2b6a-0000-4000-8000-0000000000a1',
      time_known: true,
      engine_version: 'sweph-2.10',
      created_at: nowIso(-119 * DAY),
    },
    subscription: {
      plan: 'month',
      is_active: true,
      expires_at: nowIso(21 * DAY),
      auto_renew: false,
      stars_paid_total: 798,
    },
    grants: [
      {
        id: 'g-15',
        kind: 'all_access',
        source: 'admin',
        days: 14,
        starts_at: nowIso(-6 * DAY),
        expires_at: nowIso(8 * DAY),
        consumed_at: null,
        revoked_at: null,
        created_at: nowIso(-6 * DAY),
      },
    ],
    payments: [
      {
        charge_id: 'chg_9001',
        plan_code: 'month_399',
        amount_stars: 399,
        status: 'paid',
        is_test: false,
        paid_at: nowIso(-9 * DAY),
      },
      {
        charge_id: 'chg_8100',
        plan_code: 'month_399',
        amount_stars: 399,
        status: 'refunded',
        is_test: false,
        paid_at: nowIso(-39 * DAY),
        refunded_at: nowIso(-38 * DAY),
      },
      {
        charge_id: 'chg_7001',
        plan_code: 'test_1',
        amount_stars: 1,
        status: 'failed',
        is_test: true,
        paid_at: nowIso(-40 * DAY),
      },
    ],
    counts: { reports: 4, compatibility: 1, questions: 12, forecasts: 2 },
    cost_rub: 18.4,
  },
  {
    user_id: '2b1f7a04-9d3c-4e21-8a55-000000000002',
    alias: 'banned_ivan',
    created_at: nowIso(-300 * DAY),
    last_seen_at: nowIso(-40 * DAY),
    telegram_id: '777004',
    push_enabled: false,
    banned: true,
    banned_at: nowIso(-10 * DAY),
    ban_reason: 'массовые промпты-спамы в генерации',
    subscription: null,
    grants: [],
    payments: [],
    counts: { reports: 0, compatibility: 0, questions: 0, forecasts: 0 },
    cost_rub: 0,
  },
  {
    // Без `profile` и `chart`: человек не заполнял анкету — экран обязан
    // показать «данных нет», а не ошибку.
    user_id: '2b1f7a04-9d3c-4e21-8a55-000000000003',
    alias: 'maria_new',
    created_at: nowIso(-14 * DAY),
    last_seen_at: null,
    push_enabled: true,
    banned: false,
    subscription: null,
    grants: [
      {
        id: 'g-21',
        kind: 'single_report',
        source: 'partner',
        days: null,
        starts_at: null,
        expires_at: null,
        consumed_at: nowIso(-13 * DAY),
        revoked_at: null,
        created_at: nowIso(-14 * DAY),
      },
    ],
    payments: [
      {
        charge_id: 'chg_9500',
        plan_code: 'one_149',
        amount_stars: 149,
        status: 'processed',
        is_test: false,
        paid_at: nowIso(-13 * DAY),
      },
    ],
    counts: { reports: 1, compatibility: 0, questions: 0, forecasts: 0 },
    cost_rub: 4.2,
  },
];

/**
 * Лента платежей — `AdminPaymentEntry`. Один `user_id: null`: платёж мог быть
 * сделан человеком, которого потом удалили, и это «не знаем», а не «нулевой
 * человек».
 */
export const mockPayments: AdminPaymentEntry[] = [
  {
    charge_id: 'chg_9001',
    user_id: DEMO_USER_ID,
    amount_stars: 399,
    currency: 'XTR',
    status: 'paid',
    created_at: nowIso(-9 * DAY),
    refunded_at: null,
    plan_code: 'month_399',
  },
  {
    charge_id: 'chg_8100',
    user_id: DEMO_USER_ID,
    amount_stars: 399,
    currency: 'XTR',
    status: 'refunded',
    created_at: nowIso(-39 * DAY),
    refunded_at: nowIso(-38 * DAY),
    plan_code: 'month_399',
  },
  {
    charge_id: 'chg_9500',
    user_id: '2b1f7a04-9d3c-4e21-8a55-000000000003',
    amount_stars: 149,
    currency: 'XTR',
    status: 'processed',
    created_at: nowIso(-13 * DAY),
    refunded_at: null,
    plan_code: 'one_149',
  },
  {
    charge_id: 'chg_orphan',
    user_id: null,
    amount_stars: 1,
    currency: 'XTR',
    status: 'failed',
    created_at: nowIso(-2 * DAY),
    refunded_at: null,
    plan_code: 'test_1',
  },
];

/**
 * Разборы: один `failed` с кодом ошибки (его и перегенерируют), один `ready`,
 * один всё ещё `queued`. `cost_rub` — уже потрачено на LLM, возврат по упавшему
 * разбору считается сервером, не панелью.
 */
export const mockReports: AdminReportSummary[] = [
  {
    id: '0f0c2b6a-0000-4000-8000-0000000000b1',
    user_id: DEMO_USER_ID,
    chart_id: '0f0c2b6a-0000-4000-8000-0000000000a1',
    kind: 'report',
    status: 'failed',
    error_code: 'UPSTREAM_LLM',
    attempts: 3,
    cost_rub: 3.1,
    created_at: nowIso(-4 * HOUR),
    updated_at: nowIso(-3 * HOUR),
  },
  {
    id: '0f0c2b6a-0000-4000-8000-0000000000b2',
    user_id: '2b1f7a04-9d3c-4e21-8a55-000000000003',
    chart_id: '0f0c2b6a-0000-4000-8000-0000000000a2',
    kind: 'compat',
    status: 'queued',
    error_code: null,
    attempts: 0,
    cost_rub: 0,
    created_at: nowIso(-20 * MINUTE),
    updated_at: nowIso(-20 * MINUTE),
  },
  {
    id: '0f0c2b6a-0000-4000-8000-0000000000b3',
    user_id: DEMO_USER_ID,
    chart_id: '0f0c2b6a-0000-4000-8000-0000000000a1',
    kind: 'report',
    status: 'ready',
    attempts: 1,
    cost_rub: 2.7,
    created_at: nowIso(-9 * DAY),
    updated_at: nowIso(-9 * DAY + 4 * MINUTE),
  },
];

/** Места «первых 50»: `username` удалён из контракта в 1.6.18 — поля нет. */
export const mockFounders: AdminFounder[] = [
  {
    place: 1,
    user_id: DEMO_USER_ID,
    telegram_id: '777003',
    created_at: nowIso(-90 * DAY),
    grant_kind: 'all_access',
    expires_at: null,
    code_activated: true,
  },
  {
    place: 2,
    user_id: '2b1f7a04-9d3c-4e21-8a55-000000000004',
    telegram_id: '777006',
    created_at: nowIso(-88 * DAY),
    grant_kind: 'all_access',
    expires_at: nowIso(275 * DAY),
    code_activated: false,
  },
  {
    // Право кончилось, место осталось: «—» в «действует до» важнее нуля.
    place: 3,
    user_id: '2b1f7a04-9d3c-4e21-8a55-000000000005',
    telegram_id: '777007',
    created_at: nowIso(-80 * DAY),
    grant_kind: null,
    expires_at: null,
    code_activated: false,
  },
];

/** Партнёры: один с нулём активаций — «код раздавали, никто не пришёл». */
export const mockPartners: AdminPartner[] = [
  {
    partner_name: 'podcast-razbor',
    codes_total: 5,
    activations_total: 41,
    activated_users: 38,
    paid_users: 12,
    revenue_stars: 4788,
    last_activation_at: nowIso(-3 * HOUR),
  },
  {
    partner_name: 'astro-chat',
    codes_total: 2,
    activations_total: 7,
    activated_users: 7,
    paid_users: 0,
    revenue_stars: 0,
    last_activation_at: nowIso(-11 * DAY),
  },
  {
    partner_name: 'leaflet-2026',
    codes_total: 1,
    activations_total: 0,
    activated_users: 0,
    paid_users: 0,
    revenue_stars: 0,
    last_activation_at: null,
  },
];

/** Состояние дампа для `POST /admin/backup/run`: один запуск на 10 минут. */
export const MOCK_BACKUP_WINDOW_MS = 10 * MINUTE;

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
