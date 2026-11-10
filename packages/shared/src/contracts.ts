/**
 * Типы, зеркалящие `api.openapi.yaml` v1.0.0.
 * Источник правды — контракт в корне репозитория; здесь только типы для кода.
 * При изменении контракта меняется и этот файл (и версия в `info.version`).
 */

import type { QuotaCode } from './quotas';

/** `Problem.code` — единый набор кодов ошибок. */
export const PROBLEM_CODES = [
  'UNAUTHORIZED',
  'FORBIDDEN',
  'NOT_FOUND',
  'VALIDATION_FAILED',
  'QUOTA_EXCEEDED',
  'PAYMENT_REQUIRED',
  'RATE_LIMITED',
  'INTERNAL',
  'UPSTREAM_LLM',
  'GEO_NOT_FOUND',
] as const;

export type ProblemCode = (typeof PROBLEM_CODES)[number];

/** Тело ответа об ошибке, `application/problem+json`. */
export interface Problem {
  readonly code: ProblemCode;
  /** Текст для показа пользователю (ru). */
  readonly message: string;
  /** Для поиска в логах; совпадает с заголовком `X-Request-Id`. */
  readonly request_id: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export type SubscriptionPlanName = 'none' | 'trial' | 'week' | 'month' | 'year';

export interface SubscriptionState {
  readonly plan: SubscriptionPlanName;
  readonly is_active: boolean;
  /** ISO-8601, `null` если подписки не было. */
  readonly expires_at: string | null;
  /** Управляется пользователем в настройках Telegram — только чтение. */
  readonly auto_renew: boolean;
  readonly stars_paid_total?: number;
}

export interface Quota {
  readonly code: QuotaCode;
  readonly used: number;
  /** `-1` — безлимит. */
  readonly limit: number;
  /** ISO-8601. */
  readonly reset_at: string;
}

export type OnboardingStep = 'birth_date' | 'birth_time' | 'birth_place' | 'done';

export interface Me {
  /** Внутренний UUID, не telegram_id. */
  readonly user_id: string;
  readonly display_name?: string | null;
  readonly is_new: boolean;
  readonly has_profile: boolean;
  readonly has_chart?: boolean;
  readonly subscription: SubscriptionState;
  readonly quotas: readonly Quota[];
  readonly onboarding_step?: OnboardingStep;
}

export interface HealthResponse {
  readonly status: 'ok' | 'degraded';
  readonly version: string;
  readonly db: 'ok' | 'down';
  readonly llm: 'ok' | 'down' | 'unknown';
}
