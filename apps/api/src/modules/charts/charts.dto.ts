import { z } from 'zod';
import type { FieldError } from '@astro-soul/shared';
import { invalidFields } from '../../common/api-error';

/**
 * Валидация входа `POST /charts` (контракт 1.3.0).
 *
 * Любая ошибка — `422 VALIDATION_FAILED` с `details.field_errors[{field, message}]`:
 * фронт подсвечивает поле по `field`, текст уже на «ты» и готов к показу.
 */
export const TIME_PRECISIONS = ['exact', 'approximate', 'unknown'] as const;
export type TimePrecision = (typeof TIME_PRECISIONS)[number];

export const MIN_AGE_YEARS = 18;
/** Значение по умолчанию, если окружение не задано (тесты и локальный запуск). */
export const CONSENT_VERSION_FALLBACK = '2026-11-10';
export const MIN_BIRTH_YEAR = 1900;
const HH_MM = /^([01]\d|2[0-3]):[0-5]\d$/;

export const geoPlaceSchema = z.object({
  name: z.string().trim().min(1).max(120),
  region: z.string().max(120).nullish(),
  country: z.string().regex(/^[A-Z]{2}$/),
  lat: z.number().gte(-90).lte(90),
  lon: z.number().gte(-180).lte(180),
  tz: z.string().min(1).max(64),
});

export const consentSchema = z.object({
  accepted: z.literal(true),
  version: z.string().min(1).max(32),
});

export const chartCreateSchema = z.object({
  birth_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  birth_time: z.string().regex(HH_MM).nullish(),
  time_precision: z.enum(TIME_PRECISIONS),
  birth_place: geoPlaceSchema,
  consent: consentSchema,
});

export type ChartCreateBody = z.infer<typeof chartCreateSchema>;

/** Текст ошибки по полю: короткий, на «ты», без технических кодов. */
const FIELD_MESSAGE: Readonly<Record<string, string>> = {
  birth_date: 'Укажи дату рождения в формате ГГГГ-ММ-ДД',
  birth_time: 'Укажи время рождения в формате ЧЧ:ММ или отметь, что не знаешь',
  time_precision: 'Укажи, насколько точно известно время рождения',
  birth_place: 'Выбери город рождения из подсказок',
  consent: 'Без согласия на обработку данных мы не можем построить карту',
};

function messageFor(p: string): string {
  return FIELD_MESSAGE[p] ?? 'Проверь это поле';
}

/** Валиден ли IANA-пояс: `Intl` знает тот же список, что и движок. */
/**
 * Когда наступает 18 лет — правило контракта 1.3.0: ровно в 00:00 UTC дня
 * рождения. Для рождённых 29 февраля в невисокосный год — 1 марта
 * (`Date.UTC` сам переносит такой день на следующий месяц).
 *
 * Фронт повторяет это правило один в один, поэтому расходиться они не должны.
 */
export function adultAt(birthDate: Date): Date {
  return new Date(
    Date.UTC(
      birthDate.getUTCFullYear() + MIN_AGE_YEARS,
      birthDate.getUTCMonth(),
      birthDate.getUTCDate(),
    ),
  );
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function fail(errors: readonly FieldError[], reason: string): never {
  throw invalidFields(errors, { reason });
}

/**
 * Разбор и проверка тела. Порядок проверок = порядок полей в форме,
 * чтобы фронт подсвечивал первое сверху.
 */
export function parseChartCreate(
  body: unknown,
  now: Date = new Date(),
  consentVersion: string = CONSENT_VERSION_FALLBACK,
): ChartCreateBody {
  const parsed = chartCreateSchema.safeParse(body);

  if (!parsed.success) {
    const errors: FieldError[] = [];
    const seen = new Set<string>();

    for (const issue of parsed.error.issues) {
      const field = issue.path[0] === undefined ? 'body' : String(issue.path[0]);
      if (seen.has(field)) {
        continue;
      }
      seen.add(field);
      errors.push({ field, message: messageFor(field) });
    }

    fail(errors, 'chart_create_invalid');
  }

  const input = parsed.data;
  const errors: FieldError[] = [];

  const birthDate = new Date(`${input.birth_date}T00:00:00Z`);
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

  if (Number.isNaN(birthDate.getTime()) || birthDate.toISOString().slice(0, 10) !== input.birth_date) {
    errors.push({ field: 'birth_date', message: 'Такой даты не существует' });
  } else if (birthDate.getTime() > today.getTime()) {
    errors.push({ field: 'birth_date', message: 'Дата рождения не может быть в будущем' });
  } else if (birthDate.getUTCFullYear() < MIN_BIRTH_YEAR) {
    errors.push({
      field: 'birth_date',
      message: `Мы строим карты для рождённых не раньше ${MIN_BIRTH_YEAR} года`,
    });
  } else if (now.getTime() < adultAt(birthDate).getTime()) {
    errors.push({ field: 'birth_date', message: 'Сервис доступен с 18 лет' });
  }

  const birthTime = input.birth_time ?? null;
  if (input.time_precision === 'unknown' && birthTime !== null) {
    errors.push({ field: 'birth_time', message: 'Если время неизвестно, оставь это поле пустым' });
  }
  if (input.time_precision !== 'unknown' && birthTime === null) {
    errors.push({ field: 'birth_time', message: 'Укажи время рождения или отметь, что не знаешь' });
  }

  if (input.consent.version !== consentVersion) {
    errors.push({
      field: 'consent.version',
      message: 'Условия обновились — подтверди согласие ещё раз',
    });
  }

  const place = input.birth_place;
  if (!isValidTimeZone(place.tz)) {
    errors.push({ field: 'birth_place', message: 'Не знаем такой часовой пояс — выбери город заново' });
  }
  if (place.country !== place.country.toUpperCase()) {
    errors.push({ field: 'birth_place', message: 'Код страны — две заглавные буквы (RU, KZ)' });
  }

  if (errors.length > 0) {
    fail(errors, 'chart_create_invalid');
  }

  return input;
}
