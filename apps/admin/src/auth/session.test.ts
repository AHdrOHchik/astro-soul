/*
 * Сессия: четыре разных «нет» не должны выглядеть одинаково. Разница между
 * «не вошёл», «сервер не умеет входить» и «сеть упала» — это разница между
 * «иди авторизуйся», «ждём релиз бэкенда» и «проверь, что API жив».
 */

import { describe, expect, it, vi } from 'vitest';
import { createSessionStore, isExpired } from './session';
import { createTokenStore } from './tokenStore';
import type { AdminApi } from '../api/admin';
import { ApiError } from '../api/errors';
import type { ProbeResult } from '../api/http';
import type { AdminMe } from '../api/types';

/** Стаб async-метода без `async`-стрелки: тело и так готовое значение. */
function resolved<T>(value: T): () => Promise<T> {
  return () => Promise.resolve(value);
}

function meOk(session: AdminMe): () => Promise<ProbeResult<AdminMe>> {
  return resolved({ kind: 'ok' as const, result: { data: session, status: 200, requestId: null, demo: false } });
}

const future = new Date(Date.now() + 3_600_000).toISOString();
const ADMIN = { tg_id: '42', name: 'Владелец', expires_at: future, csrf_token: 'csrf-1' };

function api(overrides: Partial<AdminApi> = {}): AdminApi {
  return {
    health: vi.fn(),
    foundersCount: vi.fn(),
    alerts: vi.fn(),
    metrics: vi.fn(),
    codes: vi.fn(),
    createCode: vi.fn(),
    grants: vi.fn(),
    grantWrite: vi.fn(),
    plans: vi.fn(),
    plansPatch: vi.fn(),
    plansHistory: vi.fn(),
    usersSearch: vi.fn(),
    userCard: vi.fn(),
    userRefund: vi.fn(),
    userBan: vi.fn(),
    userPush: vi.fn(),
    me: vi.fn(resolved({ kind: 'unavailable' as const, demo: false })),
    login: vi.fn(resolved({ data: { ok: true }, status: 200, requestId: null, demo: false })),
    logout: vi.fn(resolved({ data: { ok: true }, status: 200, requestId: null, demo: false })),
    ...overrides,
  };
}

describe('сессия админки', () => {
  it('маршрута /admin/me нет → состояние «нет серверного входа», а не «ошибка»', async () => {
    const store = createSessionStore(api(), createTokenStore());
    await store.refresh();

    expect(store.getSnapshot()).toMatchObject({ kind: 'no-auth-route' });
    expect(store.csrfToken()).toBeNull();
  });

  it('401 → анонимный вход, токен не выдуман', async () => {
    const store = createSessionStore(api({ me: vi.fn(resolved({ kind: 'unauthorized' as const, demo: false })) }), createTokenStore());
    await store.refresh();

    expect(store.getSnapshot().kind).toBe('anonymous');
    expect(store.csrfToken()).toBeNull();
  });

  it('200 → live, CSRF-токен попадает в хранилище', async () => {
    const tokens = createTokenStore();
    const store = createSessionStore(api({ me: vi.fn(meOk(ADMIN)) }), tokens);
    await store.refresh();

    expect(store.getSnapshot()).toMatchObject({ kind: 'live', session: { tgId: '42', name: 'Владелец' } });
    expect(store.csrfToken()).toBe('csrf-1');
    expect(tokens.get()).toBe('csrf-1');
  });

  it('имя отсутствует — показывается tg_id, а не пустота', async () => {
    const store = createSessionStore(api({ me: vi.fn(meOk({ tg_id: '42', expires_at: future, csrf_token: 'csrf-1' })) }), createTokenStore());
    await store.refresh();

    expect(store.getSnapshot()).toMatchObject({ kind: 'live', session: { name: '42' } });
  });

  it('сессия без CSRF-токена — ошибка, а не «всё хорошо»', async () => {
    const store = createSessionStore(api({ me: vi.fn(meOk({ tg_id: '42', name: 'Владелец', expires_at: future })) }), createTokenStore());
    await store.refresh();

    expect(store.getSnapshot()).toMatchObject({ kind: 'error', error: { code: 'CSRF_MISSING' } });
    expect(store.csrfToken()).toBeNull();
  });

  it('сессия без tg_id — сломанный ответ сервера, а не пустое имя', async () => {
    const store = createSessionStore(api({ me: vi.fn(meOk({ name: 'Владелец', csrf_token: 'csrf-1' })) }), createTokenStore());
    await store.refresh();

    expect(store.getSnapshot()).toMatchObject({ kind: 'error', error: { code: 'INVALID_RESPONSE' } });
  });

  it('истёкшая сессия не показывает панель', async () => {
    const store = createSessionStore(
      api({ me: vi.fn(meOk({ ...ADMIN, expires_at: new Date(Date.now() - 1_000).toISOString() })) }),
      createTokenStore(),
    );
    await store.refresh();

    expect(store.getSnapshot().kind).toBe('anonymous');
    expect(store.csrfToken()).toBeNull();
  });

  it('401 от любого запроса гасит сессию немедленно', async () => {
    const store = createSessionStore(api({ me: vi.fn(meOk(ADMIN)) }), createTokenStore());
    await store.refresh();
    expect(store.getSnapshot().kind).toBe('live');

    store.handleUnauthorized();
    expect(store.getSnapshot().kind).toBe('anonymous');
    expect(store.csrfToken()).toBeNull();
  });

  it('ошибка сети отличается от «не вошёл»', async () => {
    const store = createSessionStore(
      api({
        me: vi.fn(
          resolved<ProbeResult<AdminMe>>({
            kind: 'error',
            error: new ApiError({ code: 'NETWORK', status: null, message: 'API не отвечает', route: 'GET /api/v1/admin/me' }),
          }),
        ),
      }),
      createTokenStore(),
    );
    await store.refresh();

    expect(store.getSnapshot()).toMatchObject({ kind: 'error', error: { code: 'NETWORK' } });
  });

  it('выход: запрос уходит, локальная сессия гасится даже при ошибке сети', async () => {
    const logout = vi.fn(() =>
      Promise.reject(new ApiError({ code: 'NETWORK', status: null, message: 'network down', route: 'POST /api/v1/admin/auth/logout' })),
    );
    const tokens = createTokenStore();
    const store = createSessionStore(api({ me: vi.fn(meOk(ADMIN)), logout }), tokens);
    await store.refresh();
    await store.signOut();

    expect(logout).toHaveBeenCalledOnce();
    expect(store.getSnapshot().kind).toBe('anonymous');
    expect(tokens.get()).toBeNull();
  });

  it('вход: successful login перечитывает сессию и не оставляет старого токена', async () => {
    const tokens = createTokenStore();
    // Очередь, а не `mockImplementationOnce`: тот подменяет ПЕРВЫЙ вызов, а нам
    // нужно, чтобы до входа сервер отвечал 401, а после — профиль.
    const answers: (() => Promise<ProbeResult<AdminMe>>)[] = [resolved({ kind: 'unauthorized' as const, demo: false }), meOk(ADMIN)];
    const me = vi.fn((): Promise<ProbeResult<AdminMe>> => {
      const answer = answers.shift();
      if (answer === undefined) throw new Error('панель спросила /admin/me чаще, чем следовало');
      return answer();
    });
    const store = createSessionStore(api({ me, login: vi.fn(resolved({ data: { ok: true }, status: 200, requestId: null, demo: false })) }), tokens);

    await store.refresh();
    expect(store.getSnapshot().kind).toBe('anonymous');

    await store.signIn({ id: '42', auth_date: '1', hash: 'h' });
    expect(store.getSnapshot()).toMatchObject({ kind: 'live' });
    expect(tokens.get()).toBe('csrf-1');
  });

  it('isExpired: пустого срока достаточно, чтобы не считать его истёкшим', () => {
    expect(isExpired(null, Date.now())).toBe(false);
    expect(isExpired('не дата', Date.now())).toBe(false);
    expect(isExpired(new Date(Date.now() - 1).toISOString(), Date.now())).toBe(true);
  });
});
