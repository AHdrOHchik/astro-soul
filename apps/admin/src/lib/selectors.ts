/*
 * Как из ответов контракта получаются строки интерфейса.
 *
 * Функции чистые и без React: их можно проверить, и в них же живёт единственное
 * право на интерпретацию серверных чисел. Правило: поля, которого нет в
 * `api.openapi.yaml`, здесь не появляется — вместо выдуманного нуля `null`, и
 * экран рисует EMPTY.
 */

import type { AccessCode, Alert, AlertsResponse, GrantRow, Health, Metrics } from '../api/types';
import { ru } from '../i18n/ru';
import { hoursSince } from './format';

/** Порог «планировщик молчит»: ТЗ §4.1 — два часа. */
export const PUSH_SILENCE_HOURS = 2;

export interface HealthView {
  readonly status: 'ok' | 'degraded' | 'unknown';
  /** HTTP-статус был 503: без БД сервис не обслуживает ничего. */
  readonly httpFailed: boolean;
  readonly version: string | null;
  readonly db: string | null;
  readonly llm: string | null;
  readonly astro: string | null;
  readonly webhook: string | null;
  readonly checkedAt: string | null;
  readonly testPlans: boolean | null;
  readonly reportBreaker: boolean | null;
  readonly bonusSpent: number | null;
  readonly bonusLimit: number | null;
  readonly bonusExhausted: boolean | null;
  readonly pushEnabled: boolean | null;
  readonly pushLastRunAt: string | null;
  readonly pushLastSent: number | null;
  /** Часы молчания планировщика; `null` — времени последнего прогона нет. */
  readonly pushSilentHours: number | null;
}

export function healthView(health: Health, httpFailed: boolean, now: number): HealthView {
  const flags = health.flags;
  const push = flags?.push;
  const bonus = flags?.bonus_budget;

  return {
    status: health.status === 'degraded' ? 'degraded' : health.status === 'ok' ? 'ok' : 'unknown',
    httpFailed,
    version: health.version ?? null,
    db: health.db ?? null,
    llm: health.llm ?? null,
    astro: health.astro ?? null,
    webhook: health.telegram_webhook ?? null,
    checkedAt: health.checked_at ?? null,
    testPlans: flags?.test_plans ?? null,
    reportBreaker: flags?.report_breaker ?? null,
    bonusSpent: bonus?.spent_rub ?? null,
    bonusLimit: bonus?.limit_rub ?? null,
    bonusExhausted: bonus?.exhausted ?? null,
    pushEnabled: push?.enabled ?? null,
    pushLastRunAt: push?.last_run_at ?? null,
    pushLastSent: push?.last_sent_count ?? null,
    // Молчание считаем только при включённом пуше: выключенный планировщик молчать не обязан.
    pushSilentHours: push?.enabled === true ? hoursSince(push.last_run_at ?? null, now) : null,
  };
}

export function pushIsSilent(view: HealthView): boolean {
  if (view.pushEnabled !== true) return false;
  if (view.pushLastRunAt === null) return true;
  return view.pushSilentHours === null ? false : view.pushSilentHours > PUSH_SILENCE_HOURS;
}

/** На Обзор выходят только сработавшие алерты: «неподтверждённых» как отдельного поля в контракте нет. */
export function firedAlerts(response: AlertsResponse): readonly Alert[] {
  return (response.alerts ?? []).filter((alert) => alert.fired);
}

export function allAlerts(response: AlertsResponse): readonly Alert[] {
  return response.alerts ?? [];
}

export interface LabeledValue {
  readonly label: string;
  readonly value: number | null;
  readonly note?: string;
}

function num(metrics: Metrics, key: keyof Metrics): number | null {
  const value = metrics[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function rowsFor<K extends keyof Metrics>(metrics: Metrics, keys: readonly K[], labels: Record<K, string>): readonly LabeledValue[] {
  return keys.map((key) => ({ label: labels[key], value: num(metrics, key) }));
}

export const FUNNEL_KEYS = ['app_open', 'consent_accepted', 'chart_created', 'checkout_opened', 'payment_succeeded'] as const;
export type FunnelKey = (typeof FUNNEL_KEYS)[number];

export function funnelRows(metrics: Metrics): readonly LabeledValue[] {
  const funnel = metrics.funnel_30d;
  return FUNNEL_KEYS.map((key) => ({ label: ru.overview.funnelSteps[key], value: funnel?.[key] ?? null }));
}

/**
 * Четыре статьи трат LLM. Разборы за 24 часа контрактом не отдаются: строка
 * есть, значения нет — это и есть ответ «данных нет», а не ноль.
 */
export function llmSpendRows(metrics: Metrics): readonly LabeledValue[] {
  return [
    { label: ru.overview.llmForecast, value: num(metrics, 'forecast_cost_rub_24h'), note: 'за 24 ч' },
    { label: ru.overview.llmQuestions, value: num(metrics, 'questions_cost_rub_24h'), note: 'за 24 ч' },
    { label: ru.overview.llmCompat, value: num(metrics, 'compat_cost_rub_24h'), note: 'за 24 ч' },
    { label: ru.overview.llmReports, value: null, note: ru.overview.llmNoDayNote },
  ];
}

const PAYMENT_KEYS = [
  'pre_checkout_total_24h',
  'pre_checkout_rejected_24h',
  'pre_checkout_timeout_24h',
  'successful_payment_total_24h',
  'payment_failed_24h',
  'pending_payments_now',
  'amount_mismatch_30d',
  'refunded_30d',
  'test_payments_30d',
] as const satisfies readonly (keyof Metrics)[];

export function paymentRows(metrics: Metrics): readonly LabeledValue[] {
  return rowsFor(metrics, PAYMENT_KEYS, ru.overview.paymentRows);
}

const PUSH_KEYS = ['push_sent_24h', 'push_failed_24h', 'push_skipped_no_tz_24h', 'push_duplicate_prevented_24h', 'push_claimed_not_sent_24h'] as const satisfies readonly (keyof Metrics)[];

export function pushMetricRows(metrics: Metrics): readonly LabeledValue[] {
  return rowsFor(metrics, PUSH_KEYS, ru.overview.pushRows);
}

const GRANT_KEYS = ['grants_active', 'codes_activated_24h', 'referrals_joined_24h', 'referrals_rewarded_24h', 'founders_taken'] as const satisfies readonly (keyof Metrics)[];

export function grantRows(metrics: Metrics): readonly LabeledValue[] {
  return rowsFor(metrics, GRANT_KEYS, ru.overview.grantRows);
}

const BREAKER_KEYS = ['reports_failed_30d', 'reports_validation_streak'] as const satisfies readonly (keyof Metrics)[];

export function breakerRows(metrics: Metrics): readonly LabeledValue[] {
  return rowsFor(metrics, BREAKER_KEYS, ru.overview.breakerRows);
}

/** `grants_issued_24h` — словарь по источникам: ключа нет, если из источника не выдавали. */
export function grantsBySource(metrics: Metrics): readonly { source: string; value: number }[] {
  const issued = metrics.grants_issued_24h;
  if (!issued) return [];
  const rows = Object.entries(issued)
    .filter((entry): entry is [string, number] => typeof entry[1] === 'number')
    .map((entry) => ({ source: entry[0], value: entry[1] }));
  return rows.sort((a, b) => b.value - a.value);
}

export type CodeState = 'active' | 'expired' | 'exhausted' | 'inactive';

/** Состояние кода — только из полей ответа, без догадок про счётчики. */
export function codeState(code: AccessCode, now: number): CodeState {
  if (!code.is_active) return 'inactive';
  if (typeof code.max_activations === 'number' && typeof code.activations === 'number' && code.activations >= code.max_activations) {
    return 'exhausted';
  }
  if (typeof code.expires_at === 'string' && new Date(code.expires_at).getTime() <= now) return 'expired';
  return 'active';
}

export const CODE_STATE_LABEL: Record<CodeState, string> = {
  active: ru.overview.codeStates.active,
  expired: ru.overview.codeStates.expired,
  exhausted: ru.overview.codeStates.exhausted,
  inactive: ru.overview.codeStates.inactive,
};

export type GrantState = 'active' | 'used' | 'expired' | 'revoked';

export function grantState(grant: GrantRow, now: number): GrantState {
  if (grant.revoked) return 'revoked';
  if (grant.consumed_at !== null && grant.consumed_at !== undefined) return 'used';
  if (typeof grant.expires_at === 'string' && new Date(grant.expires_at).getTime() <= now) return 'expired';
  return 'active';
}

export const GRANT_STATE_LABEL: Record<GrantState, string> = {
  active: ru.overview.grantStates.active,
  used: ru.overview.grantStates.used,
  expired: ru.overview.grantStates.expired,
  revoked: ru.overview.grantStates.revoked,
};

/** UUID-проверка поля `user_id`: сервер ответил бы 422, но показать это лучше сразу. */
export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.trim());
}
