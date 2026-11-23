/*
 * Проверка того, что панель делает ДО всяких данных: пока сервер не умеет
 * входить, она не притворяется рабочей — показывает список отсутствующих
 * маршрутов и не трогает приватные адреса.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { createAdminApi } from './api/admin';
import { createFetchLog, jsonResponse } from './testing/fetchLog';
import { createHttp } from './api/http';
import { createSessionStore } from './auth/session';
import { createTokenStore } from './auth/tokenStore';

const health = {
  status: 'ok',
  version: '1.6.14',
  db: 'ok',
  telegram_webhook: 'ok',
  checked_at: new Date().toISOString(),
  flags: { test_plans: false, report_breaker: true, push: { enabled: false, last_run_at: null, last_sent_count: 0 }, bonus_budget: { spent_rub: 0, limit_rub: 100, exhausted: false } },
};

function renderApp(options: { me: 'unavailable' | 'unauthorized' | 'live' } = { me: 'unavailable' }) {
  const log = createFetchLog((url) =>
    url.includes('/api/v1/health')
      ? jsonResponse(health)
      : new Response(JSON.stringify({ code: 'NOT_FOUND', message: 'Такой страницы нет.', request_id: 'r' }), {
          status: 404,
          headers: { 'Content-Type': 'application/problem+json' },
        }),
  );

  const tokens = createTokenStore();
  const http = createHttp({ fetchImpl: log.fetchImpl, csrfToken: () => tokens.get(), allowUnknownRoutes: true });
  const api = createAdminApi(http);
  if (options.me === 'live') {
    api.me = vi.fn(() => Promise.resolve({
      kind: 'ok' as const,
      result: {
        data: { tg_id: '42', name: 'Владелец', expires_at: new Date(Date.now() + 3_600_000).toISOString(), csrf_token: 'csrf' },
        status: 200,
        requestId: null,
        demo: false,
      },
    }));
  }
  if (options.me === 'unauthorized') {
    api.me = vi.fn(() => Promise.resolve({ kind: 'unauthorized' as const, demo: false }));
  }

  const session = createSessionStore(api, tokens);
  render(<App api={api} session={session} demo={false} />);
  return { log, session };
}

describe('входной гейт', () => {
  afterEach(cleanup);

  it('без серверных маршрутов входа панель говорит «недоступно» и не дёргает приватные адреса', async () => {
    const { log } = renderApp();

    expect(await screen.findByText('Вход недоступен: сервер ещё не принимает сессии')).toBeInTheDocument();
    expect(screen.getByText('POST /api/v1/admin/auth/telegram')).toBeInTheDocument();
    expect(screen.getByText('GET /api/v1/admin/me')).toBeInTheDocument();
    expect(screen.getByText('POST /api/v1/admin/auth/logout')).toBeInTheDocument();

    // Ни одного запроса к приватным маршрутам: только попытка узнать сессию.
    const urls = log.urls();
    expect(urls.filter((url) => url.includes('/admin/metrics') || url.includes('/admin/alerts'))).toHaveLength(0);
  });

  it('из экрана входа можно открыть публичную часть — и только её', async () => {
    const { log } = renderApp();

    fireEvent.click(await screen.findByRole('button', { name: /Обзор/ }));

    await waitFor(() => expect(screen.getByText('Состояние сервиса')).toBeInTheDocument());
    const urls = log.urls();
    expect(urls.some((url) => url.includes('/api/v1/health'))).toBe(true);
    expect(urls.filter((url) => url.includes('/admin/metrics'))).toHaveLength(0);
    expect(screen.getAllByText(/Сессии нет/).length).toBeGreaterThan(0);
  });

  it('с живой сессией панель показывает Обзор и имя админа', async () => {
    renderApp({ me: 'live' });

    expect(await screen.findByText('Владелец')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Выйти' })).toBeInTheDocument();
  });

  it('меню показывает все восемь разделов, шесть — с пометкой «нет маршрутов»', async () => {
    renderApp({ me: 'live' });
    await screen.findByText('Владелец');

    const nav = screen.getByRole('navigation');
    expect(nav.querySelectorAll('a')).toHaveLength(8);
    expect(nav.querySelectorAll('.nav__mark')).toHaveLength(6);
  });
});
