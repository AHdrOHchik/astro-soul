/**
 * Типы API — из контракта, а не «по памяти».
 *
 * `generated.ts` создаётся `openapi-typescript` из `api.openapi.yaml`
 * (`pnpm gen:contracts`, проверка актуальности — `gen:contracts:check` в typecheck).
 * Здесь только удобные алиасы поверх сгенерированных типов: если контракт
 * изменится, сломается сборка, а не прод.
 */

import type { components, paths } from './contracts/generated';

type Schemas = components['schemas'];

/** `Problem.code` — единый набор кодов ошибок. */
export type ProblemCode = Schemas['Problem']['code'];

/** Тело ответа об ошибке, `application/problem+json`. */
export type Problem = Schemas['Problem'];

export type SubscriptionPlanName = Schemas['SubscriptionState']['plan'];
export type SubscriptionState = Schemas['SubscriptionState'];

export type Quota = Schemas['Quota'];
export type QuotaCode = Schemas['Quota']['code'];

export type Me = Schemas['Me'];
export type OnboardingStep = NonNullable<Schemas['Me']['onboarding_step']>;

export type GeoPlace = Schemas['GeoPlace'];
export type PlanetPosition = Schemas['PlanetPosition'];
export type Aspect = Schemas['Aspect'];
export type Chart = Schemas['Chart'];
export type ChartCreateRequest = Schemas['ChartCreateRequest'];
export type PlanCodeName = Schemas['PlanCode'];
export type Invoice = Schemas['Invoice'];
export type Forecast = Schemas['Forecast'];
export type Report = Schemas['Report'];

/** `GET /api/v1/health` — схема объявлена прямо в пути, не в components. */
export type HealthResponse =
  paths['/api/v1/health']['get']['responses'][200]['content']['application/json'];

/** `POST /api/v1/charts` и `GET /api/v1/charts/{id}` — один и тот же конверт. */
export type ChartResponse = Schemas['ChartResponse'];
export type ChartCreatedResponse = ChartResponse;

/** Ошибка конкретного поля — для подсветки на фронте (`15.2.1`). */
export type FieldError = Schemas['FieldError'];

/** `POST /api/v1/geo/resolve` — всегда 200 и массив, пустой = «города нет». */
export type GeoResolveResponse = GeoPlace[];

/** Значения квот в том порядке, в котором их ждёт фронт. */
export const QUOTA_CODES = [
  'forecast_daily',
  'ask_daily',
  'report_month',
  'compat_month',
] as const satisfies readonly QuotaCode[];

/** Все коды ошибок контракта — для проверок полноты словаря текстов. */
export const PROBLEM_CODES = [
  'UNAUTHORIZED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'VALIDATION_FAILED',
  'QUOTA_EXCEEDED',
  'PAYMENT_REQUIRED',
  'RATE_LIMITED',
  'INTERNAL',
  'UPSTREAM_LLM',
  'GEO_NOT_FOUND',
] as const satisfies readonly ProblemCode[];
