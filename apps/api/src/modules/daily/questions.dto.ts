import { invalidFields } from '../../common/api-error';
import { parseIdempotencyKey } from '../reports/reports.dto';

/**
 * Вопрос к карте: 10–300 знаков после `trim`, без ссылок.
 *
 * Вопрос уходит в модель как есть, но **никогда** — в логи и аналитику: там
 * только `question_hash`, длина и тема (SPEC.md §7). Поэтому вся валидация
 * собрана здесь, чтобы не появилось второго места, где текст трогают.
 */
export const QUESTION_MIN = 10;
export const QUESTION_MAX = 300;

/** Ссылки запрещены: это либо спам, либо попытка протащить промпт по URL. */
const URL_LIKE = /(https?:\/\/|www\.|\b[a-zа-я0-9-]+\.(?:ru|com|net|org|io|me|ai)\b)/iu;

export interface ParsedQuestion {
  readonly text: string;
  readonly idemKey: string;
}

export interface ParseQuestionOptions {
  readonly idemKey: string | undefined;
  readonly body: unknown;
}

export function parseQuestionBody(body: unknown): string {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw invalidFields([{ field: 'question', message: 'Нужен объект с полем question' }]);
  }

  const raw = (body as { question?: unknown }).question;

  if (typeof raw !== 'string') {
    throw invalidFields([{ field: 'question', message: 'Вопрос — строка' }]);
  }

  const text = raw.trim().replace(/\s+/gu, ' ');

  if (text === '') {
    throw invalidFields([{ field: 'question', message: 'Вопрос пустой' }]);
  }

  if (text.length < QUESTION_MIN) {
    throw invalidFields([
      { field: 'question', message: `Вопрос короче ${QUESTION_MIN} знаков — добавь деталей` },
    ]);
  }

  if (text.length > QUESTION_MAX) {
    throw invalidFields([
      { field: 'question', message: `Вопрос длиннее ${QUESTION_MAX} знаков — сократи` },
    ]);
  }

  if (URL_LIKE.test(text)) {
    throw invalidFields([{ field: 'question', message: 'Ссылки в вопросе не нужны' }]);
  }

  return text;
}

/**
 * `Idempotency-Key` обязателен так же, как у разбора: повторная отправка того
 * же запроса (двойной тап, ретрай клиента) не должна стоить второго вызова.
 */
export function parseQuestionRequest(
  body: unknown,
  idempotencyKey: string | undefined,
): ParsedQuestion {
  return {
    text: parseQuestionBody(body),
    idemKey: parseIdempotencyKey(idempotencyKey),
  };
}
