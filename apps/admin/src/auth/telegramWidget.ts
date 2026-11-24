/*
 * Telegram Login Widget.
 *
 * Единственное место в панели, где к чужому origin идёт обращение — и то это
 * не `fetch`, а `<script>`, который рисует кнопку: данных пользователя он не
 * читает, он только возвращает подписанный набор полей. Ни один `fetch`/XHR к
 * чужому адресу в панели запрещён (ТЗ §2.10): все данные — со своего origin.
 *
 * Подпись полей проверяет **сервер** (`POST /admin/auth/telegram`,
 * HMAC-SHA256 от ключа, выведенного из токена бота). Клиентская проверка формы
 * ниже — только чтобы не отправлять заведомо пустой объект, и права на «тебя
 * пустили» она не даёт.
 */

import type { TelegramAuthPayload } from '../api/types';

export const WIDGET_SRC = 'https://telegram.org/js/telegram-widget.js?22';
/** Имя глобального колбэка: виджет вызывает именно строку из `data-onauth`. */
export const WIDGET_CALLBACK = 'onAstroAdminTelegramAuth';

export interface TelegramLoginUser {
  readonly id: number;
  readonly first_name?: string;
  readonly username?: string;
  readonly auth_date: number;
  readonly hash: string;
}

export interface WidgetOptions {
  readonly botUsername: string;
  readonly onAuth: (user: unknown) => void;
  readonly onError: (reason: 'no-bot' | 'load') => void;
}

declare global {
  interface Window {
    onAstroAdminTelegramAuth?: (user: unknown) => void;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Форма ответа виджета: `id`, `auth_date`, `hash`. Не проверка подписи. */
export function isTelegramLoginUser(value: unknown): value is TelegramLoginUser {
  if (!isRecord(value)) return false;
  return typeof value.id === 'number' && typeof value.auth_date === 'number' && typeof value.hash === 'string' && value.hash !== '';
}

/**
 * Что уходит на сервер. Ключи — ровно те имена, которыми подписан набор полей;
 * ничего не дописываем и не переименовываем, иначе подпись не сойдётся.
 * Типы — как дал виджет: `id` и `auth_date` остаются числами (контракт
 * принимает и строку, но «как приходит» точнее, и `Number`-округление сюда не
 * приходит вовсе), сложные значения отбрасываются — сервер ждёт плоский набор.
 */
/**
 * Подписанный набор → тело `POST /admin/auth/telegram`.
 *
 * Что отдаёт виджет, то и уходит: лишние ключи (вложенные объекты, `auth_size`)
 * отбрасываются — сервер принимает любой набор, но панель не должна передавать
 * в подпись то, что человек дописал руками. `id` и `auth_date` — числами, как
 * их отдаёт сам виджет (контракт принимает `string | number` для `id`, числа
 * убирают трактовку вида «007»); если виджет прислал их строкой, значение
 * приводится к целому, а не уходит как есть.
 */
export function toAuthPayload(user: unknown): TelegramAuthPayload | null {
  if (user === null || typeof user !== 'object') return null;
  const source = user as Record<string, unknown>;
  const payload: Record<string, unknown> = {};

  for (const key of ['id', 'first_name', 'last_name', 'username', 'photo_url', 'auth_date', 'hash'] as const) {
    const value = source[key];
    if (value === undefined || value === null) continue;
    if (key === 'id' || key === 'auth_date') {
      const numeric = typeof value === 'number' ? value : Number(value);
      if (!Number.isInteger(numeric)) continue;
      payload[key] = numeric;
      continue;
    }
    if (typeof value !== 'string') continue;
    payload[key] = value;
  }

  // Обязательное по контракту: `id`, `auth_date`, `hash`. Без любого из трёх
  // тело отправлять нечего — сервер ответит 422, и человек увидит «неполный
  // набор полей»; панель говорит это сразу, без запроса.
  if (typeof payload.id !== 'number' || typeof payload.auth_date !== 'number') return null;
  // Значение `hash` не приводится к нижнему регистру и не тримится — это
  // часть подписи; пустой (или из одних пробелов) hash отсекается, потому что
  // с ним сервер ответил бы 401 вместо честного «неполный набор».
  if (typeof payload.hash !== 'string' || payload.hash.trim() === '') return null;
  return payload as unknown as TelegramAuthPayload;
}

export function mountTelegramWidget(container: HTMLElement, options: WidgetOptions): () => void {
  const { botUsername, onAuth, onError } = options;

  if (botUsername === '') {
    onError('no-bot');
    return () => undefined;
  }

  const previous = window.onAstroAdminTelegramAuth;
  window.onAstroAdminTelegramAuth = onAuth;

  const script = document.createElement('script');
  script.async = true;
  script.src = WIDGET_SRC;
  script.setAttribute('data-telegram-login', botUsername);
  script.setAttribute('data-size', 'large');
  script.setAttribute('data-request-access', 'write');
  script.setAttribute('data-onauth', `${WIDGET_CALLBACK}(user)`);
  script.onerror = () => { onError('load'); };

  container.replaceChildren(script);

  return () => {
    container.replaceChildren();
    if (window.onAstroAdminTelegramAuth === onAuth) {
      window.onAstroAdminTelegramAuth = previous;
    }
    script.onerror = null;
  };
}
