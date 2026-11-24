/*
 * Сборка App: что показывается ДО входа и что появляется ПОСЛЕ.
 *
 * Отдельный уровень, а не только тесты экранов, потому что именно здесь
 * живёт решение «пускать ли в панель»: проба `/admin/me`, экран входа, отсутствие
 * приватных запросов до входа и то, что старых заглушек про «вход недоступен»
 * никто не вернул.
 */

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { createAdminApi } from './api/admin';
import { createHttp } from './api/http';
import { createSessionStore } from './auth/session';
import { createTokenStore } from './auth/tokenStore';
import { createFetchLog, jsonResponse, problemResponse } from './testing/fetchLog';

const future = new Date(Date.now() + 6 * 3_600_000).toISOString();

const health = {
  status: 'ok',
  version: '1.6.15',
  db: 'ok',
  llm: 'ok',
  astro: 'ok',
  telegram_webhook: 'ok',
  checked_at: new Date().toISOString(),
  flags: { test_plans: false, report_breaker: true, push: { enabled: false, last_run_at: null, last_sent_count: 0 }, bonus_budget: { spent_rub: 0, limit_rub: 100, exhausted: false } },
};

function renderApp(me: 'unauthorized' | 'live' | 'error' | 'no-route' = 'unauthorized') {
  const log = createFetchLog((url) => {
    if (url.includes('/api/v1/health')) return jsonResponse(health);
    if (url.includes('/api/v1/founders/count')) return jsonResponse({ founders: 7, target: 100 });
    if (url.includes('/admin/me')) {
      if (me === 'live') {
        return jsonResponse({ tg_id: '42', name: 'Владелец', expires_at: future, csrf_token: 'csrf-test' });
      }
      if (me === 'error') return problemResponse(500, 'INTERNAL', 'База не отвечает');
      if (me === 'no-route') return problemResponse(404, 'NOT_FOUND', 'Маршрута нет');
      return problemResponse(401, 'UNAUTHORIZED', 'Сессии нет');
    }
    // Всё приватное сюда не должно доходить ни при каком раскладе.
    return problemResponse(500, 'INTERNAL', 'панель сходила туда, куда не следовало');
  });

  const tokens = createTokenStore();
  const http = createHttp({ fetchImpl: log.fetchImpl, retries: 0, csrfToken: () => tokens.get(), onUnauthorized: () => undefined });
  const api = createAdminApi(http);
  if (me === 'unauthorized') {
    api.me = vi.fn(() => Promise.resolve({ kind: 'unauthorized' as const, demo: false }));
  }
  if (me === 'no-route') {
    api.me = vi.fn(() => Promise.resolve({ kind: 'unavailable' as const, demo: false }));
  }

  const session = createSessionStore(api, tokens);
  render(<App api={api} session={session} demo={false} />);
  return { log, session, tokens };
}

describe('входной гейт', () => {
  afterEach(cleanup);

  it('до входа приватные адреса не дёргаются, а экран входа — настоящий', async () => {
    const { log } = renderApp();

    expect(await screen.findByText(/^Панель открывается по Telegram-аккаунту из ADMIN_TG_ID/)).toBeInTheDocument();
    expect(screen.getAllByText(/BotFather/).length).toBeGreaterThan(0);
    // Формы с логином/паролем тут нет и быть не может: вход — только виджет.
    expect(document.querySelector('input[type="password"]')).toBeNull();

    const urls = log.urls();
    expect(urls.filter((url) => url.includes('/admin/metrics') || url.includes('/admin/alerts'))).toHaveLength(0);
    expect(urls.filter((url) => url.includes('/admin/audit'))).toHaveLength(0);
  });

  it('«Обзор без входа» удалён: со экрана входа в приватную часть не пускает', async () => {
    const { log } = renderApp();
    await screen.findByText(/ADMIN_TG_ID/);

    expect(screen.queryByText(/Обзор без входа/)).toBeNull();
    expect(document.querySelector('a[href="#overview"]')).toBeNull();
    expect(log.urls().filter((url) => url.includes('/admin/metrics'))).toHaveLength(0);
  });

  it('сервер болен — виден текст сервера, а не заглушка «вход недоступен»', async () => {
    renderApp('error');

    expect(await screen.findByText('База не отвечает')).toBeInTheDocument();
    expect(screen.queryByText(/Вход недоступен/)).toBeNull();
    expect(screen.queryByText(/ещё не принимает сессии/)).toBeNull();
  });

  it('404 на маршруте входа — «Сервер ещё не принимает сессии», и это единственный случай', async () => {
    renderApp('no-route');

    expect(await screen.findByText('Сервер ещё не принимает сессии')).toBeInTheDocument();
    expect(screen.queryByText(/Вход недоступен/)).toBeNull();
  });

  it('с живой сессией панель показывает Обзор, имя админа и срок сессии', async () => {
    renderApp('live');

    expect(await screen.findByText('Владелец')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Выйти' })).toBeInTheDocument();
    const meta = document.querySelector('.top__meta');
    if (meta === null) throw new Error('шапки нет');
    expect(meta.textContent).toMatch(/сессия до \d{2}:\d{2}/);
    // Подпись при часах: «сессия до» — подсказка, а не решение.
    expect(meta.querySelector('span[title]')?.getAttribute('title')).toMatch(/401/);
  });

  it('меню показывает все восемь разделов, три — с пометкой «нет маршрутов»', async () => {
    renderApp('live');
    await screen.findByText('Владелец');

    const nav = screen.getByRole('navigation');
    expect(nav.querySelectorAll('a')).toHaveLength(8);
    // «Аудит» получил маршрут в 1.6.15, «Основатели» и «Эксплуатация» — в 1.6.17,
    // поэтому пометок стало три (пользователи, платежи, тарифы). Пометка значит
    // «маршрутов нет», а не «экран готов»: сами экраны придут в PR панели.
    expect(nav.querySelectorAll('.nav__mark')).toHaveLength(3);
    const audit = [...nav.querySelectorAll('a')].find((link) => link.textContent.includes('Аудит'));
    expect(audit?.querySelector('.nav__mark')).toBeNull();
  });
});
