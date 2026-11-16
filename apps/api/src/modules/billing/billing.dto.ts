import { z } from 'zod';
import { ALL_PLAN_CODES, PLANS, type PlanCode } from '@astro-soul/shared';
import { invalidFields, type FieldErrorInput } from '../../common/api-error';

/**
 * `plan_code` проверяется по полному списку (каталог + тестовые): тестовый
 * тариф — это не «неизвестный код», а существующий план, который выключен
 * флагом. Флаг проверяется ниже, чтобы ответ был один и тот же — `422`,
 * как будто плана нет.
 */
export const invoiceRequestSchema = z.object({
  plan_code: z.enum(ALL_PLAN_CODES),
  chart_id: z.string().uuid().nullish(),
});

export type InvoiceRequestBody = z.infer<typeof invoiceRequestSchema>;

export interface InvoiceRequestOptions {
  /** `PAYMENTS_TEST_PLANS=1`: без него тестовых тарифов не существует. */
  readonly testPlansEnabled: boolean;
}

export function parseInvoiceRequest(
  body: unknown,
  options: InvoiceRequestOptions,
): { planCode: PlanCode; chartId: string | null } {
  const parsed = invoiceRequestSchema.safeParse(body);

  if (!parsed.success) {
    // QA-8: фронт подсвечивает поле по `field`, поэтому формат тот же, что
    // у остальных 422 — `details.field_errors[{field,message}]`, без `fields`.
    const errors: FieldErrorInput[] = parsed.error.issues.map((issue) => ({
      field: issue.path.join('.') === '' ? 'plan_code' : issue.path.join('.'),
      message:
        issue.path[0] === 'plan_code'
          ? 'plan_code — один из тарифов каталога'
          : `${issue.path.join('.')} — проверь значение`,
    }));

    throw invalidFields(errors, { reason: 'invoice_request_invalid' });
  }

  const chartId = parsed.data.chart_id ?? null;
  const plan = PLANS[parsed.data.plan_code];

  // Тестовый тариф без флага — «такого плана нет»: тот же `422`, тот же
  // `reason`, что у несуществующего кода. Отдельный ответ (`403`, «включи
  // флаг») подсказывал бы клиенту, что тариф существует.
  if (plan.testOnly && !options.testPlansEnabled) {
    throw invalidFields(
      [{ field: 'plan_code', message: 'plan_code — один из тарифов каталога' }],
      { reason: 'invoice_request_invalid' },
    );
  }

  // Полный разбор покупается для конкретной карты: без `chart_id` платёж
  // пришлось бы «прикреплять» к первой карте задним числом — это сюрприз,
  // из-за которого пишут в поддержку (решение владельца, контракт 1.5.2).
  if (plan.kind === 'one_off' && plan.grant === 'report' && chartId === null) {
    throw invalidFields(
      [{ field: 'chart_id', message: 'Выбери карту, для которой покупаешь разбор' }],
      { reason: 'chart_required_for_report' },
    );
  }

  return { planCode: parsed.data.plan_code, chartId };
}

/** `payload` инвойса: plan + внутренний userId + idemK. Без ПДн (payments.md §2). */
export interface InvoicePayload {
  readonly p: PlanCode;
  readonly u: string;
  readonly k: string;
}

export const PAYLOAD_MAX_BYTES = 128;

export function buildInvoicePayload(payload: InvoicePayload): string {
  const raw = JSON.stringify(payload);
  const bytes = Buffer.byteLength(raw, 'utf8');

  if (bytes > PAYLOAD_MAX_BYTES) {
    // Ошибка программиста, а не пользователя: платёж нельзя создавать с payload,
    // который Telegram отвергнет.
    throw new Error(`payload инвойса ${bytes} байт > ${PAYLOAD_MAX_BYTES}`);
  }

  return raw;
}

/** Форма UUID: `u` и `k` идут прямо в SQL-сравнения, мусор туда попасть не должен. */
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Разбор payload из вебхука. Кривой payload — не повод падать с 500. */
export function parseInvoicePayload(raw: string): InvoicePayload | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) {
      return null;
    }

    const candidate = parsed as Record<string, unknown>;
    const plan = candidate['p'];
    const userId = candidate['u'];
    const idemKey = candidate['k'];

    if (
      typeof plan !== 'string' ||
      // Полный список: инвойс тестового тарифа — такой же настоящий инвойс,
      // и его `successful_payment` обязан дойти до сверки суммы.
      !(ALL_PLAN_CODES as readonly string[]).includes(plan) ||
      typeof userId !== 'string' ||
      !UUID_SHAPE.test(userId) ||
      typeof idemKey !== 'string' ||
      !UUID_SHAPE.test(idemKey)
    ) {
      return null;
    }

    return { p: plan as PlanCode, u: userId, k: idemKey };
  } catch {
    return null;
  }
}
