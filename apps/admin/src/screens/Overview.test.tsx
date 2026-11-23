/*
 * Обзор — экран, по которому принимают решения. Значит проверяем обратное: что
 * панель НЕ рисует там, где сервер ничего не отдал, и что тревожное состояние
 * не превращается в спокойное.
 */

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAdminApi } from '../api/admin';
import { createHttp } from '../api/http';
import { createFetchLog } from '../testing/fetchLog';
import { Overview } from './Overview';

const NOW = Date.UTC(2026, 10, 20, 12, 0, 0);
const HOUR = 3_600_000;

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const healthy = {
  status: 'ok',
  version: '1.6.14',
  db: 'ok',
  llm: 'ok',
  astro: 'ok',
  telegram_webhook: 'ok',
  checked_at: new Date(NOW).toISOString(),
  flags: {
    test_plans: false,
    report_breaker: true,
    push: { enabled: true, last_run_at: new Date(NOW - HOUR).toISOString(), last_sent_count: 42 },
    bonus_budget: { spent_rub: 100, limit_rub: 1000, exhausted: false },
  },
};

const degraded = {
  ...healthy,
  status: 'degraded',
  db: 'down',
  telegram_webhook: 'unreachable',
  flags: {
    ...healthy.flags,
    test_plans: true,
    push: { enabled: true, last_run_at: new Date(NOW - 26 * HOUR).toISOString(), last_sent_count: 0 },
    bonus_budget: { spent_rub: 1000, limit_rub: 1000, exhausted: true },
  },
};

const alerts = {
  checked_at: new Date(NOW).toISOString(),
  alerts: [
    { id: 'payment_not_arriving', level: 'critical', value: 3, threshold: 0, since: new Date(NOW - 5 * HOUR).toISOString(), fired: true },
    { id: 'backup_stale', level: 'warning', value: 92, threshold: 36, since: new Date(NOW - 56 * HOUR).toISOString(), fired: true },
    { id: 'generations_failing', level: 'warning', value: 1, threshold: 5, since: null, fired: false },
  ],
};

const metrics = {
  mau: 412,
  paying: 9,
  conversion_to_paid: 0.022,
  stars_received_30d: 1840,
  llm_cost_rub_30d: 142.85,
  forecast_cost_rub_24h: 41.2,
  questions_cost_rub_24h: 12.6,
  compat_cost_rub_24h: 9.1,
  reports_failed_30d: 17,
  reports_validation_streak: 4,
  reports_breaker_open: true,
  reports_breaker_last_failed_at: new Date(NOW - HOUR).toISOString(),
  funnel_30d: { app_open: 402, consent_accepted: 361, chart_created: 288, checkout_opened: 41, payment_succeeded: 9 },
  grants_issued_24h: { partner: 2, founder: 1 },
  grants_active: 23,
  bonus_budget_spent_rub: 9400,
  bonus_budget_limit_rub: 10000,
  push_sent_24h: 0,
  push_failed_24h: 31,
};

function renderOverview(
  overrides: {
    health?: () => Response;
    withSession?: boolean;
  } = {},
) {
  const log = createFetchLog((url) => {
    if (url.includes('/api/v1/health')) return overrides.health ? overrides.health() : response(healthy);
    if (url.includes('/admin/alerts')) return response(alerts);
    if (url.includes('/admin/metrics')) return response(metrics);
    return response({ code: 'NOT_FOUND', message: 'Такой страницы нет.', request_id: 'r' }, 404);
  });

  const api = createAdminApi(createHttp({ fetchImpl: log.fetchImpl, csrfToken: () => 'токен' }));
  render(<Overview api={api} sessionLive={overrides.withSession ?? true} now={NOW} />);
  return log;
}

describe('Обзор', () => {
  beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('показывает /health как есть: статус, вебхук, флаги', async () => {
    renderOverview();
    expect(await screen.findByText('1.6.14')).toBeInTheDocument();
    expect(screen.getAllByText('ok').length).toBeGreaterThan(2);
    expect(screen.getByText('выключены')).toBeInTheDocument();
  });

  it('degraded + 503 — красным, а не «всё прочитали»', async () => {
    renderOverview({ health: () => response(degraded, 503) });

    expect((await screen.findAllByRole('alert')).length).toBeGreaterThan(0);
    expect(screen.getByText(/Сервис отвечает 503/)).toBeInTheDocument();
    expect(screen.getByText('degraded')).toBeInTheDocument();
    expect(screen.getByText(/исчерпан/)).toBeInTheDocument();
  });

  it('планировщик пуша: «молчит 26 часов», когда прогон был сутки назад', async () => {
    renderOverview({ health: () => response(degraded, 200) });

    expect(await screen.findByText(/Молчит 26 часов/)).toBeInTheDocument();
    expect(screen.getByText(/не пришёл дольше двух часов/)).toBeInTheDocument();
  });

  it('на алертах видны только сработавшие, с `since`', async () => {
    const log = renderOverview();
    await waitFor(() => { expect(log.calls.length).toBeGreaterThan(0); });

    expect(await screen.findByText('payment_not_arriving')).toBeInTheDocument();
    expect(screen.getByText('backup_stale')).toBeInTheDocument();
    // Носрабатывавший алерт — не сигнал тревоги, и на Обзор ему не место.
    expect(screen.queryByText('generations_failing')).toBeNull();
    expect(screen.getByText(/5 часов назад/)).toBeInTheDocument();
  });

  it('воронка подписана окном 30 дней, потому что других окно у маршрута нет', async () => {
    renderOverview();

    expect(await screen.findByText(/окно 30 дней/)).toBeInTheDocument();
    expect(screen.getByText('Построили карту')).toBeInTheDocument();
    expect(screen.getByText('288')).toBeInTheDocument();
    expect(screen.getByText('2,2 %')).toBeInTheDocument();
  });

  it('статьи трат LLM: у разборов за 24 часа нет значения, и это показано прочерком', async () => {
    renderOverview();

    expect(await screen.findByText('Разборы (текст и PDF)')).toBeInTheDocument();
    expect(screen.getByText(/отдельной статьи в контракте нет/)).toBeInTheDocument();
    expect(screen.getByText('41,2 ₽')).toBeInTheDocument();
    expect(screen.getByText('142,85 ₽')).toBeInTheDocument();
  });

  it('без сессии приватные блоки не запрашиваются и объясняют почему', async () => {
    const log = renderOverview({ withSession: false });

    expect((await screen.findAllByText(/Сессии нет/)).length).toBeGreaterThan(0);
    const urls = log.urls();
    expect(urls.filter((url) => url.includes('/admin/metrics'))).toHaveLength(0);
    expect(urls.filter((url) => url.includes('/admin/alerts'))).toHaveLength(0);
    // Публичный /health при этом опрашивается: он работает без входа.
    expect(urls.filter((url) => url.includes('/api/v1/health'))).toHaveLength(1);
  });

  it('топ-5 провалов: «недоступно», список маршрутов и ни одной строки данных', async () => {
    renderOverview();

    expect(await screen.findByText('Топ-5 провалов генераций')).toBeInTheDocument();
    expect(screen.getByText('Недоступно в этой версии')).toBeInTheDocument();
    expect(screen.getByText('GET /api/v1/admin/reports')).toBeInTheDocument();
    expect(screen.getByText(/Данные не отрисовываются/)).toBeInTheDocument();
  });
});
