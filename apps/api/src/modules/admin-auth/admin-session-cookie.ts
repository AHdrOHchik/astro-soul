import type { CookieOptions, Request, Response } from 'express';

/**
 * Cookie сессии админ-панели.
 *
 * Префикс `__Host-` — не украшение: браузер сам требует от такой cookie
 * `Secure`, `Path=/` и **отсутствие** `Domain`, то есть поддомен не может
 * подложить свою. Это единственная защита от «cookie fixation» поддоменом,
 * которую даёт платформа, поэтому имя менять нельзя.
 *
 * `HttpOnly` — чтобы идентификатор не читался из JS (XSS в панели не должен
 * превращаться в украденную сессию). `SameSite=Lax` — панель ходит только на
 * свой origin, а Lax не ломает переход по ссылке из Telegram.
 */

export const ADMIN_SESSION_COOKIE = '__Host-admin_session';
export const ADMIN_CSRF_HEADER = 'x-admin-csrf';

/** `Cookie` без зависимости от `cookie-parser`: нужен один ключ, а не парсер. */
export function readSessionCookie(request: Request): string | undefined {
  const header = request.headers.cookie;
  if (typeof header !== 'string' || header === '') {
    return undefined;
  }

  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index <= 0) continue;
    const name = part.slice(0, index).trim();
    if (name !== ADMIN_SESSION_COOKIE) continue;
    const value = part.slice(index + 1).trim();
    if (value === '') return undefined;
    try {
      return decodeURIComponent(value);
    } catch {
      // Кривой процент-энкодинг — это «cookie нет», а не 500 на каждом запросе.
      return undefined;
    }
  }

  return undefined;
}

function options(secure: boolean): CookieOptions {
  return {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    path: '/',
  };
}

/**
 * `Max-Age` равен сроку сессии в часах: браузер и база считают одно и то же,
 * и «cookie жива, а сессии нет» не случается.
 */
export function setSessionCookie(response: Response, id: string, ttlSeconds: number, secure: boolean): void {
  response.cookie(ADMIN_SESSION_COOKIE, id, { ...options(secure), maxAge: ttlSeconds * 1000 });
}

/**
 * Выход: тот же путь и те же атрибуты, иначе браузер оставит старую cookie.
 *
 * `Max-Age=0` ставим явно, а не через `clearCookie` (`Expires` в 1970):
 * контракт обещает `Max-Age=0`, и по нему проверяют «cookie снята» — как
 * браузер, так и тест. `Expires` тоже отправляем: старые клиенты понимают
 * только его.
 */
export function clearSessionCookie(response: Response, secure: boolean): void {
  response.cookie(ADMIN_SESSION_COOKIE, '', {
    ...options(secure),
    maxAge: 0,
    expires: new Date(0),
  });
}
