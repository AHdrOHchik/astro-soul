/*
 * Транспорт админ-панели. Отличается от клиента мини-аппа принципиально:
 *
 *   • Никакого `initData` в заголовках: панель живёт в обычном браузере, где
 *     его нет. Доступ даёт cookie-сессия (`__Host-admin_session`), которую
 *     ставит сервер, а не решает фронт.
 *   • Только один origin: все запросы идут относительными путями на
 *     `admin.<домен>`, а `/api/*` проксируется на backend. Поэтому
 *     `credentials: 'same-origin'` и никаких «а давай укажем VITE_API_BASE_URL
 *     на api.<домен>» — эта ветка не проверяется ни одним прогоном, и в
 *     конструкторе это запрещено явно.
 *   • CSRF обязателен на каждом изменяющем запросе, и на dev тоже: токен
 *     приходит с `GET /admin/me` и уходит заголовком `X-Admin-CSRF`.
 *     Ни один `POST`/`PATCH`/`DELETE` без токена не отправляется.
 *   • Маршруты, которых нет в контракте, не дёргаются вовсе: экран получает
 *     состояние «недоступно» и не рисует данных.
 *
 * Сессионный токен, cookie и ответ виджета в логи не пишутся — ни целиком, ни
 * частями.
 */

import { config } from '../env';
import { ApiError, clientError, errorFromResponse, toApiError } from './errors';
import { ADMIN_ROUTES, route as lookupRoute, routeLabel, type AdminRoute, type RouteMethod } from './routes';

export const CSRF_HEADER = 'X-Admin-CSRF';
export const REQUEST_ID_HEADER = 'X-Request-Id';
/** Ставит только dev-мокер: по нему панель понимает, что данные вымышлены. */
export const DEMO_HEADER = 'X-Admin-Demo';

export const DEFAULT_TIMEOUT_MS = 15_000;
export const DEFAULT_RETRIES = 2;

const MUTATING: readonly RouteMethod[] = ['POST', 'PATCH'];

export type QueryValue = string | number | boolean | null | undefined;

export interface CallOptions {
  readonly query?: Readonly<Record<string, QueryValue>>;
  /**
   * Подстановки в шаблон пути: `{ id: '42' }` превращает `/admin/users/{id}`
   * в `/admin/users/42`. Значения экранируются — `id` приходит из строки
   * поиска или из буфера обмена, и `../etc` в нём обязан остаться текстом,
   * а не маршрутом.
   */
  readonly params?: Readonly<Record<string, string | number>>;
  readonly body?: unknown;
  /** Статусы, которые не считаются ошибкой: у `/health` 503 — это валидный ответ с телом. */
  readonly treatAsOk?: readonly number[];
  /** Только для GET: повтор после 5xx. Изменяющие запросы не повторяются никогда. */
  readonly retry?: boolean;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export interface HttpResult<T> {
  readonly data: T;
  readonly status: number;
  readonly requestId: string | null;
  /** `true`, если ответ пришёл от dev-мокера, а не от API. */
  readonly demo: boolean;
}

export type ProbeResult<T> =
  | { readonly kind: 'ok'; readonly result: HttpResult<T> }
  | { readonly kind: 'unauthorized'; readonly demo: boolean }
  | { readonly kind: 'unavailable'; readonly demo: boolean }
  | { readonly kind: 'error'; readonly error: ApiError };

export interface HttpOptions {
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly retries?: number;
  readonly retryDelayMs?: (attempt: number) => number;
  /** Токен CSRF из сессии. `null` — сессии нет, изменяющий запрос запрещён. */
  readonly csrfToken?: () => string | null;
  /** Сервер сказал 401 — панель немедленно гасит сессию у себя. */
  readonly onUnauthorized?: () => void;
  /**
   * Разрешить запросы на маршруты, которых нет в контракте. Ставится в `true`
   * **только** в dev с включённым мокером (`import.meta.env.DEV &&
   * VITE_ADMIN_DEMO=1`): иначе маршруты входа (`/admin/me`, `/admin/auth/*`)
   * вообще не опрашиваются, а экран честно говорит «недоступно». В прод-сборке
   * флаг всегда `false`, и неизвестный путь неоткуда получить.
   */
  readonly allowUnknownRoutes?: boolean;
}

function buildUrl(item: AdminRoute, query?: CallOptions['query'], params?: CallOptions['params']): string {
  let path = item.path;
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      path = path.replace(`{${key}}`, encodeURIComponent(String(value)));
    }
  }
  // Незаполненный `{placeholder}` уехал бы в сеть как есть — и это был бы
  // 404, который выглядит как «нет строки». Шаблон без подстановки — ошибка
  // вызова, она видна сразу и только в тестах.
  if (path.includes('{')) throw new Error(`Маршрут ${item.path} вызван без параметра пути`);
  const base = config.apiBaseUrl + path;
  if (!query) return base;
  // Значения подрезаются, пустые уходят вовсе: uuid вставляют из буфера обмена
  // вместе с пробелом, и «u-1 » сервер прочтёт как другой идентификатор и
  // ответит 422 там, где должен был отдать список. Ноль и `false` при этом
  // остаются — это осмысленные значения фильтра, а не отсутствие значения.
  const parts: string[] = [];
  for (const [key, value] of Object.entries(query)) {
    if (value === null || value === undefined) continue;
    const text = typeof value === 'string' ? value.trim() : String(value);
    if (text === '') continue;
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(text)}`);
  }
  return parts.length === 0 ? base : `${base}?${parts.join('&')}`;
}

/**
 * Единственная точка, где решается, можно ли вообще идти к серверу:
 * маршрута нет в контракте — запрос не отправляется. Плюс проверка CSRF для
 * изменяющих методов.
 */
export function assertCallable(item: AdminRoute, csrfToken: string | null, allowUnknownRoutes = false): void {
  if (!item.inContract && !allowUnknownRoutes) {
    throw new ApiError({
      code: 'ROUTE_NOT_IN_CONTRACT',
      status: null,
      message: `Маршрута ${routeLabel(item)} нет в контракте ${config.contractVersion}`,
      route: item.path,
    });
  }
  if (MUTATING.includes(item.method) && csrfToken === null) {
    throw new ApiError({
      code: 'CSRF_MISSING',
      status: null,
      message: 'Нет CSRF-токена: вход не завершён, изменяющий запрос не отправлен.',
      route: item.path,
    });
  }
}

export function baseUrlIsAllowed(): boolean {
  return config.apiBaseUrl === '';
}

function isDemo(headers: Headers): boolean {
  return headers.get(DEMO_HEADER) === '1';
}

async function readBody(response: Response): Promise<unknown> {
  if (response.status === 204) return undefined;
  const text = await response.text();
  if (text === '') return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

export interface Http {
  /** Типизированный вызов: бросает `ApiError` на любой не-2xx (кроме `treatAsOk`). */
  call<T>(key: string, options?: CallOptions): Promise<HttpResult<T>>;
  /** Тот же вызов, но коды разбираются без исключений — для `GET /admin/me`. */
  probe<T>(key: string, options?: CallOptions): Promise<ProbeResult<T>>;
}

export function createHttp(options: HttpOptions = {}): Http {
  if (!baseUrlIsAllowed()) {
    throw new Error(
      'VITE_API_BASE_URL задан — так панель уедет на чужой origin и потеряет cookie-сессию. ' +
        'Схема одна: admin.<домен> проксирует /api/*. См. apps/admin/README.md.',
    );
  }

  const doFetch = options.fetchImpl ?? ((input, init) => fetch(input, init));
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retries = options.retries ?? DEFAULT_RETRIES;
  const retryDelayMs = options.retryDelayMs ?? ((attempt: number) => 300 * 3 ** attempt);
  const csrfToken = options.csrfToken ?? (() => null);
  const allowUnknownRoutes = options.allowUnknownRoutes ?? false;

  async function once(item: AdminRoute, callOptions: CallOptions): Promise<Response> {
    // Проверка «можно ли идти к серверу» — один раз на запрос, до первой
    // попытки: она не зависит от того, сколько раз мы уже повторили GET.
    const token = csrfToken();
    assertCallable(item, token, allowUnknownRoutes);

    // Повтор — цикл, а не рекурсия: `return once(...)` из `try` значил бы, что
    // ошибка повторной попытки уйдёт мимо обработки текущей.
    for (let attempt = 0; ; attempt += 1) {
      const controller = new AbortController();
      const deadline = setTimeout(() => { controller.abort(); }, callOptions.timeoutMs ?? timeoutMs);
      const onAbort = (): void => {
        controller.abort();
      };
      callOptions.signal?.addEventListener('abort', onAbort);

      const init: RequestInit = {
        method: item.method,
        credentials: 'same-origin',
        headers: {
          Accept: 'application/json, application/problem+json',
          ...(MUTATING.includes(item.method) ? { [CSRF_HEADER]: token ?? '' } : {}),
          ...(callOptions.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: callOptions.body === undefined ? undefined : JSON.stringify(callOptions.body),
        signal: controller.signal,
      };

      try {
        const response = await doFetch(buildUrl(item, callOptions.query, callOptions.params), init);
        const retryable = item.method === 'GET' && (callOptions.retry ?? true) && response.status >= 500 && attempt < retries;
        if (!retryable) return response;
        response.body?.cancel().catch(() => undefined);
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs(attempt)));
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError' && !callOptions.signal?.aborted) {
          throw clientError('TIMEOUT', 'API не ответил за отведённое время.', routeLabel(item));
        }
        throw error;
      } finally {
        clearTimeout(deadline);
        callOptions.signal?.removeEventListener('abort', onAbort);
      }
    }
  }

  async function send(item: AdminRoute, callOptions: CallOptions): Promise<{ response: Response; body: unknown }> {
    try {
      const response = await once(item, callOptions);
      return { response, body: await readBody(response) };
    } catch (error) {
      throw toApiError(error, routeLabel(item));
    }
  }

  return {
    async call<T>(key: string, callOptions: CallOptions = {}): Promise<HttpResult<T>> {
      const item = lookupRoute(key);
      const { response, body } = await send(item, callOptions);
      const requestId = response.headers.get(REQUEST_ID_HEADER);
      const treatAsOk = callOptions.treatAsOk ?? [];

      if (!response.ok && !treatAsOk.includes(response.status)) {
        if (response.status === 401) options.onUnauthorized?.();
        // «404 на маршруте, которого нет в контракте» — это не ошибка сервера, а
        // отсутствие маршрута: экран обязан показать «недоступно», а не красный
        // блок, который хочется перезагрузить.
        if (response.status === 404 && !item.inContract) {
          throw new ApiError({
            code: 'ROUTE_NOT_IN_CONTRACT',
            status: 404,
            message: `Маршрута ${routeLabel(item)} нет в контракте ${config.contractVersion}`,
            requestId,
            route: item.path,
          });
        }
        throw errorFromResponse(response.status, body, requestId, routeLabel(item));
      }

      return { data: body as T, status: response.status, requestId, demo: isDemo(response.headers) };
    },

    async probe<T>(key: string, callOptions: CallOptions = {}): Promise<ProbeResult<T>> {
      const item = lookupRoute(key);
      if (!item.inContract && !allowUnknownRoutes) return { kind: 'unavailable', demo: false };

      try {
        const { response, body } = await send(item, callOptions);
        const demo = isDemo(response.headers);
        if (response.ok) {
          return { kind: 'ok', result: { data: body as T, status: response.status, requestId: response.headers.get(REQUEST_ID_HEADER), demo } };
        }
        // 404 от маршрута, который есть только в надежде фронта: это «маршрута
        // нет», а не «ошибка сервера». Тест на это состояние и проверяет, что
        // экран входа не притворяется рабочим.
        if (response.status === 404 && !item.inContract) return { kind: 'unavailable', demo };
        if (response.status === 401) {
          options.onUnauthorized?.();
          return { kind: 'unauthorized', demo };
        }
        return { kind: 'error', error: errorFromResponse(response.status, body, response.headers.get(REQUEST_ID_HEADER), routeLabel(item)) };
      } catch (error) {
        return { kind: 'error', error: toApiError(error, routeLabel(item)) };
      }
    },
  };
}

/** Для тестов и для отчёта: чем панель вообще пользуется. */
export function callableRoutes(): readonly AdminRoute[] {
  return ADMIN_ROUTES.filter((item) => item.inContract);
}
