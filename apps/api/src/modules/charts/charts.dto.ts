import { z } from 'zod';
import { validationFailed, type ApiError } from '../../common/api-error';

/**
 * Валидация входа `POST /charts`. Контракт: `ChartCreateRequest`.
 * Ошибка → 422 VALIDATION_FAILED с перечнем полей (без значений, без ПДн).
 */
export const geoPlaceSchema = z.object({
  name: z.string().min(1).max(120),
  region: z.string().max(120).nullish(),
  country: z.string().length(2),
  lat: z.number().gte(-90).lte(90),
  lon: z.number().gte(-180).lte(180),
  tz: z.string().min(1).max(64),
});

export const chartCreateSchema = z.object({
  birth_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'ожидается YYYY-MM-DD'),
  birth_time: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'ожидается HH:MM')
    .nullish(),
  birth_place: geoPlaceSchema,
});

export type ChartCreateBody = z.infer<typeof chartCreateSchema>;

export const MIN_AGE_YEARS = 18;

/** Все ошибки входа `POST /charts` — 422 VALIDATION_FAILED (контракт). */
function invalidChart(reason: string, details?: Record<string, unknown>): ApiError {
  return validationFailed({ status: 422, reason, ...(details === undefined ? {} : { details }) });
}

export function parseChartCreate(body: unknown, now: Date = new Date()): ChartCreateBody {
  const parsed = chartCreateSchema.safeParse(body);

  if (!parsed.success) {
    throw invalidChart('chart_create_invalid', {
      fields: parsed.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        code: issue.code,
      })),
    });
  }

  const birthDate = new Date(`${parsed.data.birth_date}T00:00:00Z`);
  if (Number.isNaN(birthDate.getTime())) {
    throw invalidChart('birth_date_invalid');
  }

  if (birthDate.getTime() > now.getTime()) {
    throw invalidChart('birth_date_in_future', { field: 'birth_date' });
  }

  const adultCutoff = new Date(
    Date.UTC(now.getUTCFullYear() - MIN_AGE_YEARS, now.getUTCMonth(), now.getUTCDate()),
  );
  if (birthDate.getTime() > adultCutoff.getTime()) {
    throw invalidChart('under_18', { field: 'birth_date' });
  }

  return parsed.data;
}
