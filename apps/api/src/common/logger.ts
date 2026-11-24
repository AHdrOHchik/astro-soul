import { currentRequestId } from './request-context';
import { maskSecrets } from './secret-url';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_WEIGHT: Readonly<Record<LogLevel, number>> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

/**
 * Ключи, которые не должны попасть в лог ни при каких условиях
 * (SPEC «Приватность», AGENTS.md §8): дата/время/место рождения, координаты,
 * telegram_id, сырой initData и содержимое разборов.
 *
 * `url`, `expected_url`, `actual_url`, `request_uri` — Б-4 (итерация 45):
 * адрес вебхука содержит `TELEGRAM_WEBHOOK_SECRET` в пути, и логирование
 * адреса = логирование секрета. Значения этих ключей маскируются ещё и
 * вызывающей стороной (`maskWebhookUrl`/`maskSecretPath`), а запись в списке
 * запрещённых — вторая линия: новое `logger.info(..., { url })` не протечёт
 * молча, даже если автор о маскировании не подумал.
 */
const FORBIDDEN_KEYS = new Set([
  'birth_date',
  'birthdate',
  'birth_time',
  'birthtime',
  'birth_place',
  'birthplace',
  'place',
  'place_name',
  'lat',
  'lon',
  'latitude',
  'longitude',
  'coordinates',
  'telegram_id',
  'telegramid',
  'init_data',
  'initdata',
  'x-telegram-init-data',
  'first_name',
  'last_name',
  'username',
  'phone',
  'email',
  'question',
  'answer',
  'chapters',
  'report_text',
  'forecast_text',
  'url',
  'webhook_url',
  'expected_url',
  'actual_url',
  'request_uri',
]);

const REDACTED = '[redacted]';
const MAX_DEPTH = 4;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function redact(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) {
    return '[truncated]';
  }

  // Error/Date — не «плоские объекты»: их содержимое нужнее, чем ключи.
  if (value instanceof Error || value instanceof Date) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => redact(item, depth + 1));
  }

  if (isPlainObject(value)) {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      result[key] = FORBIDDEN_KEYS.has(key.toLowerCase()) ? REDACTED : redact(item, depth + 1);
    }
    return result;
  }

  // Б-4: любая строка лога проходит через маску секрета вебхука — в том числе
  // та, что пришла не из поля `url`, а из текста ошибки или склейки пути.
  return typeof value === 'string' ? maskSecrets(value) : value;
}

function serialize(line: Record<string, unknown>): string {
  return JSON.stringify(line, (_key, value: unknown) => {
    if (typeof value === 'bigint') {
      return value.toString();
    }
    // `msg` и `base` в `redact` не попадают — маскируем их здесь (Б-4).
    if (typeof value === 'string') {
      return maskSecrets(value);
    }
    if (value instanceof Error) {
      return { name: value.name, message: value.message, stack: value.stack };
    }
    return value;
  });
}

/** Однострочный JSON-лог: его читает Loki/ELK, а не человек. */
export class JsonLogger {
  constructor(
    private readonly minLevel: LogLevel = 'info',
    private readonly base: Readonly<Record<string, unknown>> = {},
  ) {}

  child(fields: Readonly<Record<string, unknown>>): JsonLogger {
    return new JsonLogger(this.minLevel, { ...this.base, ...fields });
  }

  debug(message: string, fields: Readonly<Record<string, unknown>> = {}): void {
    this.write('debug', message, fields);
  }

  info(message: string, fields: Readonly<Record<string, unknown>> = {}): void {
    this.write('info', message, fields);
  }

  warn(message: string, fields: Readonly<Record<string, unknown>> = {}): void {
    this.write('warn', message, fields);
  }

  error(message: string, fields: Readonly<Record<string, unknown>> = {}): void {
    this.write('error', message, fields);
  }

  private write(level: LogLevel, message: string, fields: Readonly<Record<string, unknown>>): void {
    if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[this.minLevel]) {
      return;
    }

    const line = {
      ts: new Date().toISOString(),
      level,
      msg: message,
      request_id: currentRequestId(),
      ...this.base,
      ...(redact(fields) as Record<string, unknown>),
    };

    process.stdout.write(serialize(line) + '\n');
  }
}

export const LOGGER = Symbol('LOGGER');
