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
 * Значения — строки: сервер разберёт их сам.
 */
export function toAuthPayload(value: unknown): Record<string, string> | null {
  if (!isRecord(value)) return null;
  const payload: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    // Объектные поля (`auth_date` в виде строки у других версий виджета) не сериализуем:
    // сервер ждёт плоский набор подписанных строк.
    if (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean') {
      payload[key] = String(raw);
    }
  }
  return Object.keys(payload).length === 0 ? null : payload;
}

/**
 * Вставляет скрипт виджета в `container`. Возвращает функцию уборки: глобальный
 * колбэк чужой библиотеки обязан быть снят, иначе второй смонтированный экран
 * начнёт принимать чужие колбэки.
 */
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
