/*
 * Сессия: «нет» бывают разные, и каждый со своим адресатом. «Не вошёл»,
 * «истекла», «разлогинился кнопкой», «сеть упала» — четыре разных экрана и
 * четыре разных действия человека. Маршруты входа в контракте с 1.6.15,
 * поэтому «ждём релиз бэкенда» остался только как защитная ветка.
 */

import { describe, expect, it, vi } from 'vitest';
import { createSessionStore, isExpired } from './session';
import { createTokenStore } from './tokenStore';
import type { AdminApi } from '../api/admin';
import { ApiError } from '../api/errors';
import type { ProbeResult } from '../api/http';
import type { AdminMe } from '../api/types';

/** Всё, что лежит в хранилище, одной строкой — искать «токен не просочился». */
function dump(storage: Storage): string {
  const parts: string[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key !== null) parts.push(`${key}=${storage.getItem(key) ?? ''}`);
  }
  return parts.join(';');
}

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
    payments: vi.fn(),
    reports: vi.fn(),
    reportRegenerate: vi.fn(),
    founders: vi.fn(),
    partners: vi.fn(),
    backupRun: vi.fn(),
    webhookSet: vi.fn(),
    alertAck: vi.fn(),
    me: vi.fn(resolved({ kind: 'unavailable' as const, demo: false })),
    login: vi.fn(resolved({ data: { ok: true }, status: 200, requestId: null, demo: false })),
    logout: vi.fn(resolved({ data: { ok: true }, status: 200, requestId: null, demo: false })),
    audit: vi.fn(),
    ...overrides,
  };
}

describe('сессия админки', () => {
  it('если реестр и контракт разъехались (probe: unavailable) — «сервер не принимает», а не «о сети»', async () => {
    const store = createSessionStore(api(), createTokenStore());
    await store.refresh();

    expect(store.getSnapshot()).toMatchObject({ kind: 'error', error: { code: 'ROUTE_NOT_IN_CONTRACT' } });
    expect(store.csrfToken()).toBeNull();
  });

  it('401 → анонимный вход, токен не выдуман', async () => {
    const store = createSessionStore(api({ me: vi.fn(resolved({ kind: 'unauthorized' as const, demo: false })) }), createTokenStore());
    await store.refresh();

    expect(store.getSnapshot().kind).toBe('anonymous');
    expect(store.csrfToken()).toBeNull();
  });

  it('200 → live, токен — только в памяти: ни localStorage, ни sessionStorage не тронуты', async () => {
    const tokens = createTokenStore();
    const store = createSessionStore(api({ me: vi.fn(meOk(ADMIN)) }), tokens);
    await store.refresh();

    expect(store.getSnapshot()).toMatchObject({ kind: 'live', session: { tgId: '42', name: 'Владелец' } });
    expect(store.csrfToken()).toBe('csrf-1');
    expect(tokens.get()).toBe('csrf-1');
    // Прямая проверка запрета: токен переживал бы закрытие вкладки и читался
    // бы любым скриптом на домене — смысл CSRF-защиты в этом и теряется.
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
    expect(dump(window.localStorage)).not.toContain('csrf-1');
    expect(dump(window.sessionStorage)).not.toContain('csrf-1');
  });

  it('имя отсутствует — показывается tg_id, а не пустота', async () => {
    const store = createSessionStore(api({ me: vi.fn(meOk({ tg_id: '42', name: '', expires_at: future, csrf_token: 'csrf-1' })) }), createTokenStore());
    await store.refresh();

    expect(store.getSnapshot()).toMatchObject({ kind: 'live', session: { name: '42' } });
  });

  it('сессия без CSRF-токена — ошибка, а не «всё хорошо»', async () => {
    const store = createSessionStore(api({ me: vi.fn(meOk({ tg_id: '42', name: 'Владелец', expires_at: future, csrf_token: null })) }), createTokenStore());
    await store.refresh();

    expect(store.getSnapshot()).toMatchObject({ kind: 'error', error: { code: 'CSRF_MISSING' } });
    expect(store.csrfToken()).toBeNull();
  });

  it('сессия без tg_id — сломанный ответ сервера, а не пустое имя', async () => {
    const store = createSessionStore(api({ me: vi.fn(meOk({ tg_id: '  ', name: 'Владелец', expires_at: future, csrf_token: 'csrf-1' })) }), createTokenStore());
    await store.refresh();

    expect(store.getSnapshot()).toMatchObject({ kind: 'error', error: { code: 'INVALID_RESPONSE' } });
  });

  it('истёкшая сессия не показывает панель', async () => {
    const store = createSessionStore(
      api({ me: vi.fn(meOk({ ...ADMIN, expires_at: new Date(Date.now() - 1_000).toISOString() })) }),
      createTokenStore(),
    );
    await store.refresh();

    expect(store.getSnapshot()).toMatchObject({ kind: 'anonymous', reason: 'expired' });
    expect(store.csrfToken()).toBeNull();
  });

  it('401 от любого запроса гасит живую сессию немедленно и называет причину', async () => {
    const store = createSessionStore(api({ me: vi.fn(meOk(ADMIN)) }), createTokenStore());
    await store.refresh();
    expect(store.getSnapshot().kind).toBe('live');

    store.handleUnauthorized();
    expect(store.getSnapshot()).toMatchObject({ kind: 'anonymous', reason: 'expired' });
    expect(store.csrfToken()).toBeNull();
  });

  it('401 для анонима — «войди», без ложного «истекла»', async () => {
    const store = createSessionStore(api({ me: vi.fn(resolved({ kind: 'unauthorized' as const, demo: false })) }), createTokenStore());
    await store.refresh();
    store.handleUnauthorized();
    expect(store.getSnapshot()).toMatchObject({ kind: 'anonymous', reason: null });
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
    expect(store.getSnapshot()).toMatchObject({ kind: 'anonymous', reason: 'signed-out' });
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

    await store.signIn({ id: '42', auth_date: 1, hash: 'h' });
    expect(store.getSnapshot()).toMatchObject({ kind: 'live' });
    expect(tokens.get()).toBe('csrf-1');
  });

  it('вход после «истекла» — тот же магазин, без перезагрузки страницы', async () => {
    const answers: (() => Promise<ProbeResult<AdminMe>>)[] = [
      resolved({ kind: 'unauthorized' as const, demo: false }),
      meOk(ADMIN),
      meOk({ ...ADMIN, csrf_token: 'csrf-2' }),
    ];
    const me = vi.fn((): Promise<ProbeResult<AdminMe>> => {
      const answer = answers.shift();
      if (answer === undefined) throw new Error('панель спросила /admin/me чаще, чем следовало');
      return answer();
    });
    const tokens = createTokenStore();
    const store = createSessionStore(api({ me }), tokens);
    await store.refresh();
    expect(store.getSnapshot().kind).toBe('anonymous');

    await store.signIn({ id: '42', auth_date: 1, hash: 'h' });
    expect(store.getSnapshot().kind).toBe('live');
    expect(tokens.get()).toBe('csrf-1');

    store.handleUnauthorized();
    expect(store.getSnapshot()).toMatchObject({ kind: 'anonymous', reason: 'expired' });
    expect(tokens.get()).toBeNull();

    await store.signIn({ id: '42', auth_date: 2, hash: 'h' });
    expect(store.getSnapshot()).toMatchObject({ kind: 'live' });
    // Новый вход — новый токен из свежего `/admin/me`, а не возврат старого.
    expect(tokens.get()).toBe('csrf-2');
    expect(me).toHaveBeenCalledTimes(3);
  });

  it('отказ входа: 401 с причиной сохраняется во вью — экран обязан показать reason, а не «ой»', async () => {
    const store = createSessionStore(
      api({
        login: vi.fn(() =>
          Promise.reject(new ApiError({ code: 'UNAUTHORIZED', status: 401, message: 'Подпись не совпала.', reason: 'invalid_hash', route: 'POST /api/v1/admin/auth/telegram' }))),
      }),
      createTokenStore(),
    );
    await store.signIn({ id: '42', auth_date: 1, hash: 'плохая' });

    expect(store.getSnapshot()).toMatchObject({ kind: 'error', error: { status: 401, reason: 'invalid_hash' } });
  });

  it('isExpired: пустого срока достаточно, чтобы не считать его истёкшим', () => {
    expect(isExpired(null, Date.now())).toBe(false);
    expect(isExpired('не дата', Date.now())).toBe(false);
    expect(isExpired(new Date(Date.now() - 1).toISOString(), Date.now())).toBe(true);
  });
});
