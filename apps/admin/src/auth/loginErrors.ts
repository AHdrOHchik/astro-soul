/*
 * Тексты отказа входа. Отдельный модуль и отдельная функция — потому что
 * смешивать эти причины нельзя: у каждой свой адресат.
 *
 *   invalid_hash / auth_stale — человек и Telegram: переподписаться,
 *       обновить страницу;
 *   forbidden — не этот аккаунт: идти не куда, а к владельцу ADMIN_TG_ID;
 *   429 — просто подождать `retry_after` секунд;
 *   404 / «маршрута нет в контракте» — бэкенд старше контракта: это ЕДИНСТВЕННЫЙ
 *       случай, когда уместно сказать «сервер ещё не принимает сессии».
 *
 * Раньше любая причина вела последнюю фразу, и человек шёл искать проблему на
 * бэкенде, где её нет. Таблица соответствия — здесь; текст — в `ru.login.errors`.
 */

import type { ApiError } from '../api/errors';
import { ru } from '../i18n/ru';

export function loginErrorText(error: ApiError): string {
  // «Маршрута нет» — и клиентский гейт (`ROUTE_NOT_IN_CONTRACT`), и ответ
  // живого, но старого сервера (`404` на существующий в контракте путь).
  if (error.code === 'ROUTE_NOT_IN_CONTRACT' || error.status === 404) {
    return ru.login.errors.notAccepting;
  }
  if (error.status === 429) {
    const seconds = error.retryAfterSeconds;
    return seconds !== null ? `${ru.login.errors.tooMany} ${seconds} ${ru.login.errors.tooManySuffix}` : ru.login.errors.tooManyUnknown;
  }
  if (error.status === 403) return ru.login.errors.forbidden;
  if (error.status === 401 && error.reason === 'auth_stale') return ru.login.errors.authStale;
  if (error.status === 401 && error.reason === 'invalid_hash') return ru.login.errors.invalidHash;
  // Всё прочее — слово сервера как есть: переписывать его панель не имеет права.
  return `${error.message}${error.reason ? ` (${error.reason})` : ''}`;
}
