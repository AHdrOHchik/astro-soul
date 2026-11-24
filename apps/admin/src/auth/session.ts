/*
 * Сессия админа. Маршруты входа — в контракте с 1.6.15, поэтому состояний
 * четыре, и каждое — про разный вопрос:
 *
 *   checking  — ещё не спросили;
 *   live      — сервер назвал админа, токен CSRF есть;
 *   anonymous — сервер знает адрес, но не знает, кто ты: вход. Причина
 *               подставляется отдельная (`expired` — 401 застал живую сессию,
 *               `signed-out` — вышли кнопкой), потому что «войди снова» и
 *               «тебя разлогинили» — разные сообщения человеку;
 *   error     — запрос не прошёл (сеть/500/401 с отказом виджета): текст
 *               разбирает экран входа (`loginErrors.ts`).
 *
 * Доступ решает сервер: панель не хранит «админ/не админ», только то, что ей
 * ответили. Отзыв сессии мгновенный: 401 от любого запроса гасит её здесь же,
 * не дожидаясь истечения; `expires_at` — подсказка для интерфейса, не права.
 */

import { useSyncExternalStore } from 'react';
import type { AdminApi } from '../api/admin';
import { ApiError, clientError } from '../api/errors';
import type { AdminMe, TelegramAuthPayload } from '../api/types';
import type { TokenStore } from './tokenStore';

export interface AdminSession {
  readonly tgId: string;
  readonly name: string;
  readonly expiresAt: string | null;
  readonly demo: boolean;
}

export type AnonymousReason = 'expired' | 'signed-out' | null;

export type SessionView =
  | { readonly kind: 'checking' }
  | { readonly kind: 'anonymous'; readonly reason: AnonymousReason }
  | { readonly kind: 'live'; readonly session: AdminSession }
  | { readonly kind: 'error'; readonly error: ApiError };

export interface SessionStore {
  getSnapshot(): SessionView;
  subscribe(listener: () => void): () => void;
  refresh(): Promise<void>;
  signIn(payload: TelegramAuthPayload): Promise<void>;
  signOut(): Promise<void>;
  csrfToken(): string | null;
  /** 401 от любого запроса: сессию отзываем сразу. */
  handleUnauthorized(): void;
}

const ME_ROUTE = 'GET /api/v1/admin/me';

/**
 * `/admin/me` описан контрактом (`tg_id`, `name` обязательны), но пустая
 * строка в `tg_id` всё ещё ломаный ответ: сессия без имени пользователя — не
 * «живая сессия», а основание показать ошибку.
 */
function sessionFromMe(me: AdminMe, demo: boolean): AdminSession | null {
  const tgId = me.tg_id.trim();
  if (tgId === '') return null;
  const name = me.name.trim();
  return { tgId, name: name !== '' ? name : tgId, expiresAt: me.expires_at, demo };
}

/** Просрочена ли сессия по часам браузера. Панель не продлевает её молча. */
export function isExpired(expiresAt: string | null, now: number): boolean {
  if (expiresAt === null) return false;
  const at = new Date(expiresAt).getTime();
  return !Number.isNaN(at) && at <= now;
}

export function createSessionStore(api: AdminApi, tokens: TokenStore): SessionStore {
  let view: SessionView = { kind: 'checking' };
  let csrf: string | null = null;
  const listeners = new Set<() => void>();

  const emit = () => {
    for (const listener of listeners) listener();
  };

  const setView = (next: SessionView): void => {
    view = next;
    emit();
  };

  const clear = (): void => {
    csrf = null;
    tokens.set(null);
  };

  const refresh = async (): Promise<void> => {
    setView({ kind: 'checking' });
    const probed = await api.me();

    if (probed.kind === 'unavailable') {
      // Недостижимо, пока реестр и контракт сверяет тест-страж; если разъехались
      // — сказать правду про «не принимает», а не выдумывать «о сети».
      clear();
      setView({ kind: 'error', error: clientError('ROUTE_NOT_IN_CONTRACT', 'Сервер ещё не принимает сессии.', ME_ROUTE) });
      return;
    }
    if (probed.kind === 'error') {
      clear();
      setView({ kind: 'error', error: probed.error });
      return;
    }
    if (probed.kind === 'unauthorized') {
      clear();
      setView({ kind: 'anonymous', reason: null });
      return;
    }

    const parsed = sessionFromMe(probed.result.data, probed.result.demo);
    if (parsed === null) {
      clear();
      setView({ kind: 'error', error: clientError('INVALID_RESPONSE', 'Сервер вернул сессию без tg_id.', ME_ROUTE) });
      return;
    }
    const session = parsed;

    if (isExpired(session.expiresAt, Date.now())) {
      clear();
      setView({ kind: 'anonymous', reason: 'expired' });
      return;
    }

    // Токен — только в памяти владелицы (tokenStore) и только из этого
    // ответа: при перезагрузке страницы путь один — снова `/admin/me`.
    const token = probed.result.data.csrf_token;
    csrf = token !== null && token !== '' ? token : null;
    tokens.set(csrf);

    // Без токена панель не сможет сделать ни одного изменяющего запроса, а
    // притворяться «всё хорошо» не имеет права: это тот же грех, что и цена из
    // константы вместо ответа сервера.
    if (csrf === null) {
      setView({ kind: 'error', error: clientError('CSRF_MISSING', 'Сервер вернул сессию без CSRF-токена.', ME_ROUTE) });
      return;
    }

    setView({ kind: 'live', session });
  };

  return {
    getSnapshot: () => view,

    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    csrfToken: () => csrf,

    handleUnauthorized: () => {
      const wasLive = view.kind === 'live';
      clear();
      // 401 — единственный источник правды. Живая сессия, умершая на запросе,
      // заслуживает «истекла, войди снова»; молча же «вернуться к входу» без
      // причины — значит заставлять админа искать, что он сделал не так.
      setView({ kind: 'anonymous', reason: wasLive ? 'expired' : null });
    },

    refresh,

    async signIn(payload) {
      try {
        await api.login(payload);
      } catch (error) {
        // Тексты разбирает экран (`loginErrors.ts`): `invalid_hash`,
        // `auth_stale`, `forbidden`, `429`, «404 — сервер не принимает
        // сессии» — пять разных сообщений, а не одна универсальная отговорка.
        const apiError =
          error instanceof ApiError
            ? error
            : clientError('NETWORK', 'Сервер входа не ответил', 'POST /api/v1/admin/auth/telegram');
        clear();
        setView({ kind: 'error', error: apiError });
        return;
      }

      await refresh();

      if (view.kind !== 'live') {
        setView({
          kind: 'error',
          error: new ApiError({
            code: 'UNAUTHORIZED',
            status: 401,
            message: 'Telegram подписал вход, но сервер не признал этот аккаунт админом.',
            route: ME_ROUTE,
          }),
        });
      }
    },

    async signOut() {
      try {
        await api.logout();
      } catch {
        // Выход работает и когда сервер недоступен: локальную сессию гасим всё
        // равно, токен из памяти уходит всегда.
      }
      clear();
      setView({ kind: 'anonymous', reason: 'signed-out' });
    },
  };
}

export function useSession(store: SessionStore): SessionView {
  // Стрелки, а не `store.getSnapshot`: методы `SessionStore` не объявлены с
  // `this: void`, а `useSyncExternalStore` забирает их из объекта.
  return useSyncExternalStore(
    (onStoreChange) => store.subscribe(onStoreChange),
    () => store.getSnapshot(),
    () => store.getSnapshot(),
  );
}
