/*
 * Экран входа. Главное здесь — ПЯТЬ разных текстов отказа: у каждой причины
 * свой адресат, и подменять одну другой запрещено (исторический баг: любой
 * отказ читался как «сервер ещё не принимает сессии», и человек шёл искать
 * проблему на бэкенде, где её нет).
 */

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHttp } from '../api/http';
import { createAdminApi } from '../api/admin';
import { createFetchLog, header, jsonBody, only, type Call } from '../testing/fetchLog';
import type { SessionStore } from './session';
import { createTokenStore } from './tokenStore';
import { createSessionStore, useSession } from './session';
import { Login } from './Login';

const future = new Date(Date.now() + 6 * 3_600_000).toISOString();

/** Контейнер виджета — тот же элемент до и после отказа: входить можно снова. */
function widgetHost(): Element {
  const found = document.querySelector('[aria-label="Кнопка «Log in with Telegram»"]');
  if (found === null) throw new Error('контейнера виджета нет — повторный вход требует F5');
  return found;
}

function response(body: unknown, status = 200, contentType = 'application/json'): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': contentType } });
}

function problem(status: number, code: string, message: string, details?: unknown): Response {
  return response({ code, message, request_id: 'r-1', ...(details === undefined ? {} : { details }) }, status, 'application/problem+json');
}

interface Harness {
  readonly login: () => Promise<void>;
  readonly renderLogin: () => ReturnType<typeof render>;
  readonly calls: Call[];
  readonly tokens: ReturnType<typeof createTokenStore>;
  readonly store: ReturnType<typeof createSessionStore>;
}

/** Подписка та же, что у `App`: отказ входа обязан перерисовать экран, а не потребовать F5. */
function Live({ store }: { readonly store: SessionStore }) {
  return <Login store={store} view={useSession(store)} demo={false} />;
}

/**
 * Собирает настоящий стек (http → api → session) поверх записывающего fetch,
 * чтобы проверялась и подстановка CSRF после входа, а не только тексты.
 */
function harness(loginResponse: () => Response): Harness {
  let loggedIn = false;
  const log = createFetchLog((url) => {
    if (url.includes('/admin/auth/telegram')) {
      loggedIn = loginResponse().ok;
      return loginResponse();
    }
    if (url.includes('/admin/me')) {
      return loggedIn
        ? response({ tg_id: '42', name: 'Владелец', expires_at: future, csrf_token: 'csrf-live' })
        : problem(401, 'UNAUTHORIZED', 'Сессии нет');
    }
    return problem(404, 'NOT_FOUND', 'не сюда');
  });
  const http = createHttp({ fetchImpl: log.fetchImpl, retries: 0, csrfToken: () => null });
  const api = createAdminApi(http);
  const tokens = createTokenStore();
  const store = createSessionStore(api, tokens);
  return {
    login: () => store.signIn({ id: 777001, auth_date: Math.floor(Date.now() / 1000), hash: 'х' }),
    renderLogin: () => render(<Live store={store} />),
    calls: log.calls,
    tokens,
    store,
  };
}

describe('экран входа', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it.each([
    {
      name: '401 invalid_hash',
      reply: () => problem(401, 'UNAUTHORIZED', 'Подпись не совпала.', { reason: 'invalid_hash' }),
      text: 'Telegram передал некорректную подпись. Попробуй войти ещё раз.',
    },
    {
      name: '401 auth_stale',
      reply: () => problem(401, 'UNAUTHORIZED', 'Подпись устарела.', { reason: 'auth_stale' }),
      text: 'Данные входа устарели. Обнови страницу и попробуй снова.',
    },
    {
      name: '403 forbidden',
      reply: () => problem(403, 'FORBIDDEN', 'id вне ADMIN_TG_ID.', { reason: 'forbidden' }),
      text: 'Этот аккаунт не является администратором.',
    },
    {
      name: '429 retry_after',
      reply: () => problem(429, 'RATE_LIMITED', 'Многовато попыток.', { retry_after: 37 }),
      text: 'Слишком много попыток. Повтори через 37 с',
    },
    {
      name: '404 на маршруте',
      reply: () => problem(404, 'NOT_FOUND', 'Маршрут не найден.'),
      text: 'Сервер ещё не принимает сессии',
    },
  ])('$name — свой текст, а не общий', async ({ reply, text }) => {
    const h = harness(reply);
    await h.login();
    if (h.store.getSnapshot().kind !== 'error') throw new Error('ожидался error');

    h.renderLogin();
    expect(await screen.findByText(text)).toBeInTheDocument();
  });

  it('«сервер ещё не принимает» — только у 404: другие причины не прячутся за ним', async () => {
    const h = harness(() => problem(500, 'INTERNAL', 'Упала база.'));
    await h.login();
    if (h.store.getSnapshot().kind !== 'error') throw new Error('ожидался error');
    h.renderLogin();

    expect(await screen.findByText('Упала база.')).toBeInTheDocument();
    expect(screen.queryByText(/ещё не принимает сессии/)).toBeNull();
  });

  it('после отказа виджет остаётся на месте: повторный вход — без перезагрузки', async () => {
    const h = harness(() => problem(401, 'UNAUTHORIZED', 'Подпись не совпала.', { reason: 'invalid_hash' }));
    h.renderLogin();
    await new Promise((resolve) => { setTimeout(resolve, 0); });
    const host = widgetHost();
    await h.login();
    expect(await screen.findByText('Telegram передал некорректную подпись. Попробуй войти ещё раз.')).toBeInTheDocument();

    expect(widgetHost()).toBe(host);
    // Не «ещё раз, но сначала F5»: контейнер виджета тот же и живой.
    expect(h.store.getSnapshot().kind).toBe('error');
  });

  it('после 200 панель сама спрашивает /admin/me и забирает токен в память', async () => {
    const h = harness(() => response({ ok: true }));
    h.renderLogin();
    await h.login();

    expect(h.store.getSnapshot().kind).toBe('live');
    // Два запроса: POST входа, затем GET /admin/me — панель не берёт профиль
    // из ответа логина, он и не приходит.
    const me = only(h.calls.filter((call) => call.url.includes('/admin/me')), 'запрос профиля');
    expect(me.init.method ?? 'GET').toBe('GET');
    // Нигде в хранилищах токена нет.
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
    expect(h.tokens.get()).toBe('csrf-live');
  });

  it('ответ 200 не содержит токена — панель его не ищет в логине', async () => {
    const h = harness(() => response({ ok: true }));
    await h.login();
    const login = only(h.calls.filter((call) => call.url.includes('/admin/auth/telegram')), 'POST входа');
    expect(jsonBody(login)).not.toHaveProperty('csrf_token');
    // id — числом, как его отдаёт виджет.
    expect(jsonBody(login).id).toBe(777001);
  });

  it('изменённый экран: до ответа /admin/me изменяющий POST не отправляется вовсе', async () => {
    const log = createFetchLog(() => problem(404, 'NOT_FOUND', 'не сюда'));
    const http = createHttp({ fetchImpl: log.fetchImpl, retries: 0, csrfToken: () => null });
    const api = createAdminApi(http);

    await expect(api.createCode({ kind: 'single_report', max_activations: 1 })).rejects.toMatchObject({ code: 'CSRF_MISSING' });
    // Ни одного запроса на сервер: «нет токена» — это не «сервер отказал».
    expect(log.calls).toHaveLength(0);
  });

  it('401 на приватном запросе гасит вход, а повторный вход работает без перезагрузки', async () => {
    let loggedIn = false;
    const log = createFetchLog((url) => {
      if (url.includes('/admin/auth/telegram')) {
        loggedIn = true;
        return response({ ok: true });
      }
      if (url.includes('/admin/me')) {
        return loggedIn
          ? response({ tg_id: '42', name: 'Владелец', expires_at: future, csrf_token: 'csrf-live' })
          : problem(401, 'UNAUTHORIZED', 'Сессии нет');
      }
      if (url.includes('/admin/codes')) {
        if (!loggedIn) return problem(401, 'UNAUTHORIZED', 'Сессии нет');
        loggedIn = false; // сервер отозвал сессию посреди работы
        return problem(401, 'UNAUTHORIZED', 'Сессия истекла.');
      }
      return problem(404, 'NOT_FOUND', 'не сюда');
    });
    const http = createHttp({
      fetchImpl: log.fetchImpl,
      retries: 0,
      csrfToken: () => null,
      onUnauthorized: () => {
        store.handleUnauthorized();
      },
    });
    const api = createAdminApi(http);
    const tokens = createTokenStore();
    const store = createSessionStore(api, tokens);

    await store.signIn({ id: 42, auth_date: 1, hash: 'h' });
    expect(store.getSnapshot().kind).toBe('live');

    // Приватный запрос упёрся в отозванную сессию…
    await expect(api.codes()).rejects.toBeTruthy();
    expect(store.getSnapshot()).toMatchObject({ kind: 'anonymous', reason: 'expired' });
    expect(tokens.get()).toBeNull();

    render(<Login store={store} view={store.getSnapshot()} demo={false} />);
    expect(await screen.findByText('Сессия истекла, войди снова.')).toBeInTheDocument();

    // …и второй вход — без перезагрузки страницы — возвращает панель.
    await store.signIn({ id: 42, auth_date: 2, hash: 'h' });
    expect(store.getSnapshot().kind).toBe('live');
    expect(tokens.get()).toBe('csrf-live');
    const lastPost = log.calls.filter((call) => call.init.method === 'POST').at(-1);
    if (lastPost === undefined) throw new Error('POST входа не найден');
    expect(header(lastPost, 'Content-Type')).toContain('application/json');
  });
});
