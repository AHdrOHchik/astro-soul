import { z } from 'zod';
import { ApiError, invalidFields } from '../../common/api-error';

/**
 * Вход `POST /compatibility` (контракт 1.6.0).
 *
 * Двери для ПДн партнёра здесь закрыты намеренно:
 *
 *   • `relationship` — код из закрытого перечня, а не текст: «жена Аня» в
 *     свободном поле уехало бы и в БД, и в промпт;
 *   • в теле нет ни `name`, ни `note`, ни `label` — лишние поля отвергаются
 *     (`strict`), а не игнорируются: тихо принятое поле можно потом не заметить
 *     в базе;
 *   • `place` — только `city_id` + координаты + пояс. Название города берём из
 *     справочника по координатам: модели оно не нужно, а человеку показывать
 *     место партнёра мы не собираемся.
 */
export const RELATIONSHIPS = ['romantic', 'friend', 'family', 'colleague'] as const;
export type Relationship = (typeof RELATIONSHIPS)[number];

const DATE = /^\d{4}-\d{2}-\d{2}$/u;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/u;

const partnerSchema = z
  .object({
    birth_date: z.string().regex(DATE, 'Дата рождения партнёра — в формате ГГГГ-ММ-ДД'),
    birth_time: z
      .string()
      .regex(TIME, 'Время рождения партнёра — в формате ЧЧ:ММ')
      .nullish(),
    place: z
      .object({
        city_id: z.string().min(1).max(64).nullish(),
        lat: z.number().min(-90).max(90),
        lon: z.number().min(-180).max(180),
        tz: z.string().min(1).max(64),
      })
      .strict(),
  })
  .strict();

export const compatRequestSchema = z
  .object({
    chart_id: z.string().uuid(),
    relationship: z.enum(RELATIONSHIPS),
    partner: partnerSchema,
  })
  .strict();

export type CompatRequestBody = z.infer<typeof compatRequestSchema>;

/** Дата в будущем и «слишком старая» — не данные партнёра, а опечатка. */
export const MIN_BIRTH_DATE = '1900-01-01';

const FIELD_MESSAGE: Readonly<Record<string, string>> = {
  chart_id: 'Выбери карту, по которой считаем совместимость',
  relationship: 'Укажи тип отношений: romantic, friend, family или colleague',
  'partner.birth_date': 'Укажи дату рождения партнёра',
  'partner.birth_time': 'Время рождения партнёра — ЧЧ:ММ или пропусти поле',
  'partner.place': 'Выбери место рождения партнёра из справочника',
  'partner.place.lat': 'Координаты места рождения партнёра вне диапазона',
  'partner.place.lon': 'Координаты места рождения партнёра вне диапазона',
  'partner.place.tz': 'Не указан часовой пояс места рождения партнёра',
  'Idempotency-Key': 'Повтори заказ — приложение не передало ключ идемпотентности',
};

function fieldOf(path: readonly (string | number)[]): string {
  const parts = path.filter((part): part is string => typeof part === 'string');
  if (parts.length === 0) {
    return 'body';
  }
  // Ответ `partner.place.lat`, а не `partner.place`: фронт подсвечивает поле.
  return parts.length <= 3 ? parts.join('.') : parts.slice(0, 3).join('.');
}

function todayIso(now: Date): string {
  return now.toISOString().slice(0, 10);
}

export function parseCompatRequest(body: unknown, now: Date = new Date()): CompatRequestBody {
  const parsed = compatRequestSchema.safeParse(body);

  if (!parsed.success) {
    const seen = new Set<string>();
    const errors = parsed.error.issues
      .map((issue) => {
        const field = fieldOf(issue.path);
        return { field, message: FIELD_MESSAGE[field] ?? 'Проверь это поле' };
      })
      .filter((error) => {
        if (seen.has(error.field)) {
          return false;
        }
        seen.add(error.field);
        return true;
      });

    throw invalidFields(
      errors.length === 0 ? [{ field: 'body', message: 'Проверь тело запроса' }] : errors,
      { reason: 'compat_request_invalid' },
    );
  }

  const { partner } = parsed.data;

  if (partner.birth_time !== null && partner.birth_time !== undefined) {
    // Половина времени хуже, чем его отсутствие: карта с домами по «примерно»
    // врёт о домах, а без времени честно их не считает.
    if (!TIME.test(partner.birth_time)) {
      throw invalidFields(
        [{ field: 'partner.birth_time', message: 'Время рождения партнёра — ЧЧ:ММ' }],
        { reason: 'compat_request_invalid' },
      );
    }
  }

  if (partner.birth_date > todayIso(now) || partner.birth_date < MIN_BIRTH_DATE) {
    throw invalidFields(
      [{ field: 'partner.birth_date', message: 'Проверь дату рождения партнёра' }],
      { reason: 'compat_request_invalid' },
    );
  }

  return parsed.data;
}

/**
 * `422 compat_quota_exhausted` / `422 compat_already_owned`.
 *
 * `details.reason` — машинная причина, `details.field_errors` — поле для
 * подсветки, `details.resets_at` — когда совместимость снова доступна (только
 * для подписки). Поле `reason` дублируется в `details`, потому что контракт
 * читает его оттуда, а лог — из `ApiError.reason`.
 */
export function compatRefused(input: {
  readonly reason: 'compat_already_owned' | 'compat_quota_exhausted';
  readonly message: string;
  readonly field: string;
  readonly resetsAt?: string | null;
}): ApiError {
  return new ApiError('VALIDATION_FAILED', 422, {
    message: input.message,
    reason: input.reason,
    details: {
      reason: input.reason,
      field_errors: [{ field: input.field, message: input.message }],
      ...(input.resetsAt === undefined || input.resetsAt === null
        ? {}
        : { resets_at: input.resetsAt }),
    },
  });
}
