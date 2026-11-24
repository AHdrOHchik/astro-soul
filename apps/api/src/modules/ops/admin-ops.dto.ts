import { validationFailed } from '../../common/api-error';

/**
 * Тела «операторских» действий панели (контракт 1.6.17): `POST /admin/backup/run`
 * и `POST /admin/telegram/webhook`.
 *
 * Оба требуют `reason` — как в играх «почему ты это сделал». Это не формальность:
 * бэкап вручную и переустановка вебхука меняют состояние прода, и через месяц
 * на вопрос «кто и зачем переставил вебхук» отвечает журнал, а не память.
 */
export interface AdminOpsReason {
  readonly reason: string;
}

const MIN = 5;
const MAX = 500;

export function parseOpsReason(body: unknown): AdminOpsReason {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw validationFailed({
      message: 'Ожидается объект {reason}',
      details: {
        reason: 'invalid_body',
        field_errors: [{ field: 'body', message: 'Ожидается объект {reason}' }],
      },
    });
  }

  const source = body as Record<string, unknown>;
  const unknown = Object.keys(source).filter((key) => key !== 'reason');

  if (unknown.length > 0) {
    throw validationFailed({
      message: `Поле не поддерживается. Разрешено: reason`,
      details: {
        reason: 'unknown_field',
        field_errors: unknown.map((field) => ({
          field,
          message: 'Поле не поддерживается. Разрешено: reason',
        })),
      },
    });
  }

  const value = source['reason'];

  if (typeof value !== 'string' || value.trim().length < MIN || value.trim().length > MAX) {
    throw validationFailed({
      message: `reason: строка от ${MIN} до ${MAX} символов`,
      details: {
        reason: 'invalid_reason',
        field_errors: [{ field: 'reason', message: `От ${MIN} до ${MAX} символов` }],
      },
    });
  }

  return { reason: value.trim() };
}
