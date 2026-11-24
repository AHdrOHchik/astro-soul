import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

import { maskSecretPath } from './secret-url';

export interface RequestContext {
  readonly requestId: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

export const REQUEST_ID_HEADER = 'X-Request-Id';

/** Клиентский request_id принимаем только в безопасном виде, иначе генерируем свой. */
const CLIENT_REQUEST_ID = /^[A-Za-z0-9._-]{8,64}$/;

/**
 * Путь без query и без секретов (Б-4, итерация 45).
 *
 * В middleware Nest url уже обрезан, поэтому берём originalUrl.
 * `maskSecretPath` здесь, а не в вызывающих местах, — намеренно: access-лог
 * API пишет путь на **каждый** запрос, включая `/internal/telegram/webhook/
 * <TELEGRAM_WEBHOOK_SECRET>` (его дёргает Telegram, то есть постоянно).
 * Маскирование в одной функции исключает «одно место забыли».
 */
export function requestPath(req: { originalUrl?: string; path: string }): string {
  const full = req.originalUrl ?? req.path;
  const withoutQuery = full.split('?')[0] ?? full;
  return maskSecretPath(withoutQuery.length === 0 ? '/' : withoutQuery);
}

export function resolveRequestId(headerValue: string | undefined): string {
  if (headerValue !== undefined && CLIENT_REQUEST_ID.test(headerValue)) {
    return headerValue;
  }
  return randomUUID();
}

export function runWithRequestContext<T>(context: RequestContext, handler: () => T): T {
  return storage.run(context, handler);
}

export function currentRequestId(): string {
  return storage.getStore()?.requestId ?? 'no-request-context';
}

/** `undefined`, если контекста нет: нужно, чтобы не сгенерировать второй id. */
export function peekRequestId(): string | undefined {
  return storage.getStore()?.requestId;
}
