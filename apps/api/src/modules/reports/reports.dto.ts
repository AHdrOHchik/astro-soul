import { z } from 'zod';
import { invalidFields, validationFailed } from '../../common/api-error';

/**
 * Вход `POST /reports` (контракт 1.5.1).
 *
 * `Idempotency-Key` обязателен и проверяется отдельно от тела: без него
 * пользователь, нажавший кнопку трижды, получил бы три платных разбора.
 */
export const REPORT_TYPES = ['full', 'compat', 'solar'] as const;
export type ReportType = (typeof REPORT_TYPES)[number];

export const reportRequestSchema = z.object({
  chart_id: z.string().uuid(),
  type: z.enum(REPORT_TYPES),
  partner: z.unknown().nullish(),
});

export type ReportRequestBody = z.infer<typeof reportRequestSchema>;

export const IDEMPOTENCY_KEY_MAX = 64;
const IDEMPOTENCY_KEY = /^[\w.:-]+$/u;

const FIELD_MESSAGE: Readonly<Record<string, string>> = {
  chart_id: 'Выбери карту, по которой нужен разбор',
  type: 'Укажи тип разбора: full, compat или solar',
  'Idempotency-Key': 'Повтори заказ — приложение не передало ключ идемпотентности',
};

function fieldOf(path: readonly (string | number)[]): string {
  const [head, second] = path;
  if (typeof head !== 'string') {
    return 'body';
  }
  return typeof second === 'string' ? `${head}.${second}` : head;
}

export function parseReportRequest(body: unknown): ReportRequestBody {
  const parsed = reportRequestSchema.safeParse(body);

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

    throw invalidFields(errors.length === 0 ? [{ field: 'body', message: 'Проверь тело запроса' }] : errors, {
      reason: 'report_request_invalid',
    });
  }

  // Совместимость и карта года — отдельные продукты: их сборка появится позже.
  // Честный 422 лучше, чем «в очереди» навсегда.
  if (parsed.data.type !== 'full') {
    throw validationFailed({
      message: 'Пока собираю только полный разбор — совместимость и карту года сделаю позже',
      reason: 'report_type_not_implemented',
      details: {
        field_errors: [
          {
            field: 'type',
            message: 'Пока собираю только полный разбор — совместимость и карту года сделаю позже',
          },
        ],
      },
    });
  }

  return parsed.data;
}

/** Ключ идемпотентности: обязателен, до 64 символов, без пробелов. */
export function parseIdempotencyKey(value: string | undefined): string {
  const key = value?.trim() ?? '';

  if (key === '') {
    throw invalidFields([
      { field: 'Idempotency-Key', message: FIELD_MESSAGE['Idempotency-Key'] ?? 'Повтори заказ' },
    ]);
  }

  if (key.length > IDEMPOTENCY_KEY_MAX || !IDEMPOTENCY_KEY.test(key)) {
    throw invalidFields([
      {
        field: 'Idempotency-Key',
        message: 'Ключ идемпотентности — до 64 символов: буквы, цифры, «-», «_», «.», «:»',
      },
    ]);
  }

  return key;
}
