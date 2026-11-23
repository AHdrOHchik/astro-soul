/*
 * Сессия админа. Пять состояний, и каждое — про разный вопрос:
 *
 *   checking      — ещё не спросили;
 *   live          — сервер назвал админа, токен CSRF есть;
 *   anonymous     — сервер знает адрес, но не знает, кто ты (401): вход;
 *   no-auth-route — сервер **не умеет** входить: `GET /admin/me` нет в
 *                   контракте. Это не «разлогинился», это «панели пока не на
 *                   чём ездить», и текст на экране должен быть именно такой;
 *   error         — сеть/500: вход мог бы работать, но запрос не прошёл.
 *
 * Доступ решает сервер: панель не хранит «админ/не админ», только то, что ей
 * ответили. Отзыв сессии мгновенный: 401 от любого запроса гасит её здесь же,
 * не дожидаясь истечения.
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

export type SessionView =
  | { readonly kind: 'checking' }
  | { readonly kind: 'anonymous' }
  | { readonly kind: 'live'; readonly session: AdminSession }
  | { readonly kind: 'no-auth-route'; readonly error: ApiError | null }
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
 * Поля `/admin/me` сужаются на месте: маршрут ещё не описан контрактом, и
 * сессия без `tg_id` — это не «живая сессия с пустым именем», а сломанный
 * ответ. Различать их обязан экран, а не молча подставлять прочерк.
 */
function sessionFromMe(me: AdminMe, demo: boolean): AdminSession | null {
  const tgId = typeof me.tg_id === 'string' ? me.tg_id.trim() : '';
  if (tgId === '') return null;
  const name = typeof me.name === 'string' ? me.name.trim() : '';
  return {
    tgId,
    name: name !== '' ? name : tgId,
    expiresAt: typeof me.expires_at === 'string' ? me.expires_at : null,
    demo,
  };
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
      clear();
      setView({ kind: 'no-auth-route', error: null });
      return;
    }
    if (probed.kind === 'error') {
      clear();
      setView({ kind: 'error', error: probed.error });
      return;
    }
    if (probed.kind === 'unauthorized') {
      clear();
      setView({ kind: 'anonymous' });
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
      setView({ kind: 'anonymous' });
      return;
    }

    const token = probed.result.data.csrf_token;
    csrf = typeof token === 'string' && token !== '' ? token : null;
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
      clear();
      setView({ kind: 'anonymous' });
    },

    refresh,

    async signIn(payload) {
      try {
        await api.login(payload);
      } catch (error) {
        const apiError =
          error instanceof ApiError
            ? error
            : clientError('NETWORK', 'Сервер входа не ответил', 'POST /api/v1/admin/auth/telegram');
        // 404 на маршруте, которого нет в контракте, — это «не с чем работать»,
        // а не «неверный пароль»: текст должен быть разный.
        if (apiError.code === 'ROUTE_NOT_IN_CONTRACT') {
          clear();
          setView({ kind: 'no-auth-route', error: apiError });
          return;
        }
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
      setView({ kind: 'anonymous' });
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
