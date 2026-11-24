/*
 * «Платежи и генерации». Четыре проверки, которые здесь обязательны:
 *   • «маршрута нет» — заглушка: одиночной карты платежа (`GET
 *     /admin/payments/{id}`) в контракте нет, и экран не делает таких запросов;
 *   • отказ показан текстом сервера, а не «что-то пошло не так»;
 *   • без второго шага подтвержения запрос не уходит;
 *   • «нет данных» ≠ «0»: `user_id: null` и пустая лента выглядят по-разному.
 * Плюс отдельное: `regenerate` отвечает `202` — экран обязан сказать «в
 * очереди», а не «готово».
 */

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAdminApi } from '../api/admin';
import { createHttp } from '../api/http';
import { createFetchLog, only, type Call } from '../testing/fetchLog';
import type { AdminPaymentEntry, AdminReportSummary } from '../api/types';
import { Payments } from './Payments';

const NOW = Date.UTC(2026, 10, 20, 12, 0, 0);
const DAY = 86_400_000;
const iso = (offsetMs: number): string => new Date(NOW + offsetMs).toISOString();

const charge = (overrides: Partial<AdminPaymentEntry> = {}): AdminPaymentEntry => ({
  charge_id: 'chg_9001',
  user_id: '2b1f7a04-9d3c-4e21-8a55-000000000001',
  amount_stars: 399,
  currency: 'XTR',
  status: 'paid',
  created_at: iso(-9 * DAY),
  refunded_at: null,
  plan_code: 'month_399',
  ...overrides,
});

const report = (overrides: Partial<AdminReportSummary> = {}): AdminReportSummary => ({
  id: '0f0c2b6a-0000-4000-8000-0000000000b1',
  user_id: '2b1f7a04-9d3c-4e21-8a55-000000000001',
  chart_id: '0f0c2b6a-0000-4000-8000-0000000000a1',
  kind: 'report',
  status: 'failed',
  error_code: 'UPSTREAM_LLM',
  attempts: 3,
  cost_rub: 3.1,
  created_at: iso(-4 * 3_600_000),
  updated_at: iso(-3 * 3_600_000),
  ...overrides,
});

function api(fetchImpl: typeof fetch): ReturnType<typeof createAdminApi> {
  return createAdminApi(createHttp({ fetchImpl, retries: 0, retryDelayMs: () => 0, csrfToken: () => 'токен' }));
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const problem = (status: number, code: string, message: string, details?: unknown): Response =>
  new Response(JSON.stringify({ code, message, request_id: 'r', ...(details ? { details } : {}) }), {
    status,
    headers: { 'Content-Type': 'application/problem+json' },
  });

/** Лента платежей и лента разборов по умолчанию. */
function feeds(payments: readonly AdminPaymentEntry[] = [charge()], reports: readonly AdminReportSummary[] = [report()]) {
  return createFetchLog((url, init) => {
    if ((init.method ?? 'GET') === 'POST' && url.includes('/regenerate')) {
      return json({ report_id: '0f0c2b6a-0000-4000-8000-0000000000b1', state: 'queued', attempts: 4 }, 202);
    }
    if (url.includes('/admin/payments')) return json({ items: payments, next_cursor: null });
    if (url.includes('/admin/reports')) return json({ items: reports, truncated: false });
    return json({ items: [] });
  });
}

const posts = (calls: readonly Call[]): Call[] => calls.filter((call) => call.init.method === 'POST');

/** Панель по заголовку: фильтров на экране два, и «Применить» — не уникальная кнопка. */
function panel(title: string | RegExp): HTMLElement {
  const heading = screen.getByRole('heading', { level: 2, name: title });
  const section = heading.closest('section');
  if (section === null) throw new Error(`панель «${title}» не отрисована`);
  return section;
}

/** Два нажатия HoldConfirm с паузой, сдвинутой mocked `Date.now`. */
function pressTwice(name: RegExp) {
  fireEvent.click(screen.getByRole('button', { name }));
  vi.mocked(Date.now).mockReturnValue(NOW + 2_100);
  fireEvent.click(screen.getByRole('button', { name: /Подожди ещё|Подтвердить ещё раз/ }));
}

describe('Платежи и генерации', () => {
  beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('ленты читуются фильтром, а не выдуманным адресом карты платежа', async () => {
    const { fetchImpl: fetch, calls } = feeds();
    render(<Payments api={api(fetch)} sessionLive demo={false} />);

    expect(await screen.findByText('chg_9001')).toBeInTheDocument();
    // Поиск по чеку — фильтр ленты; `GET /admin/payments/{id}` в контракта нет.
    const charges = panel('Платежи и возвраты');
    fireEvent.change(within(charges).getByLabelText('charge_id'), { target: { value: 'chg_9001' } });
    fireEvent.click(within(charges).getByRole('button', { name: 'Применить' }));
    await waitFor(() => {
      expect(calls.filter((call) => call.url.includes('charge_id=chg_9001')).length).toBe(1);
    });
    expect(calls.some((call) => /\/admin\/payments\/[^?]/.test(call.url.replace('/api/v1/admin/payments', '/api/v1/admin/payments/')))).toBe(false);
    // Ни одной ссылки «открыть платёж»: экрана карты нет и быть не может.
    expect(screen.queryByRole('button', { name: /Открыть платёж/ })).toBeNull();
    expect(screen.getByText('GET /api/v1/admin/payments/export.csv')).toBeInTheDocument();
    expect(screen.getByText('GET /api/v1/admin/payments/{id}')).toBeInTheDocument();
  });

  it('курсор: «Показать ещё» уходит ровно с next_cursor сервера и гаснет на null', async () => {
    const { fetchImpl: fetch, calls } = createFetchLog((url) =>
      url.includes('cursor=')
        ? json({ items: [charge({ charge_id: 'chg_9500' })], next_cursor: null })
        : json({ items: [charge()], next_cursor: '20' }),
    );
    render(<Payments api={api(fetch)} sessionLive demo={false} />);

    await screen.findByText('chg_9001');
    fireEvent.click(screen.getByRole('button', { name: 'Показать ещё' }));

    await waitFor(() => {
      expect(screen.getByText('chg_9500')).toBeInTheDocument();
    });
    const more = only(calls.filter((call) => call.url.includes('cursor=')), 'вторая страница');
    expect(more.url).toContain('cursor=20');
    // Дальше страниц нет: кнопка исчезает, «последняя страница 3» не появляется.
    expect(screen.queryByRole('button', { name: 'Показать ещё' })).toBeNull();
    expect(screen.getByText(/Дальше страниц нет/)).toBeInTheDocument();
  });

  it('пустая лента — «ни один платёж не подошёл», а не ошибка и не нули', async () => {
    const { fetchImpl: fetch } = feeds([], []);
    render(<Payments api={api(fetch)} sessionLive demo={false} />);

    expect(await screen.findByText('Ни один платёж под фильтр не подошёл. Это не ошибка.')).toBeInTheDocument();
    expect(screen.getByText('Ни один разбор под фильтр не подошёл.')).toBeInTheDocument();
    expect(document.querySelectorAll('.banner--crit')).toHaveLength(0);
  });

  it('null в строке платежа — прочерк, а не 0 и не пустая ячейка', async () => {
    // `user_id: null` — «сервер не назвал человека» (платёж пережил своего
    // владельца), `refunded_at: null` — «возврата не было». Ни то, ни другое
    // не имеет права выглядеть нулём.
    const { fetchImpl: fetch } = feeds([charge({ user_id: null })]);
    render(<Payments api={api(fetch)} sessionLive demo={false} />);

    await screen.findByText('chg_9001');
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByText('0')).toBeNull();
  });

  it('regenerate: без второго шага запроса нет; 202 — «в очереди», не «готово»', async () => {
    const { fetchImpl: fetch, calls } = feeds();
    render(<Payments api={api(fetch)} sessionLive demo={false} />);

    const button = await screen.findByRole('button', { name: 'Перегенерировать' });
    expect(button).toBeEnabled();

    // Первое нажатие — только вооружение: кнопка меняет подпись, запроса нет.
    fireEvent.click(button);
    expect(posts(calls)).toHaveLength(0);
    expect(screen.getByRole('button', { name: /Подожди ещё 2 с/ })).toBeInTheDocument();

    // Второе раньше паузы — тоже не запрос: «почти» не засчитывается.
    vi.mocked(Date.now).mockReturnValue(NOW + 900);
    fireEvent.click(screen.getByRole('button', { name: /Подожди ещё/ }));
    expect(posts(calls)).toHaveLength(0);

    // Своевременное второе нажатие — единственный POST, без тела.
    vi.mocked(Date.now).mockReturnValue(NOW + 2_100);
    fireEvent.click(screen.getByRole('button', { name: /Подожди ещё|Подтвердить ещё раз/ }));
    await waitFor(() => {
      expect(posts(calls)).toHaveLength(1);
    });
    const regen = only(posts(calls), 'POST перегенерации');
    expect(regen.url).toContain('/api/v1/admin/reports/0f0c2b6a-0000-4000-8000-0000000000b1/regenerate');
    // Тела у запроса нет: причина остаётся в аудите сервера. Транспорт всё
    // равно сериализует JSON, поэтому проверяем не строку, а «полей ноль».
    const regenBody: Record<string, unknown> = typeof regen.init.body === 'string' ? (JSON.parse(regen.init.body) as Record<string, unknown>) : {};
    expect(Object.keys(regenBody)).toHaveLength(0);

    // 202 = «в очереди»: состояние и счётчик попыток — из ответа сервера.
    const banner = await screen.findByText(/Разбор снова в очереди/);
    expect(banner.textContent).toContain('0f0c2b6a-0000-4000-8000-0000000000b1');
    expect(banner.textContent).toContain('Состояние после запроса: queued');
    expect(banner.textContent).toContain('Попыток 4');
    // «Готово» на этом месте было бы враньём: текст разбора появится, когда
    // лента его покажет.
    expect(screen.queryByText(/Разбор готов/)).toBeNull();
    // Лента перечитана после запроса, а не «обновится когда-нибудь».
    await waitFor(() => {
      expect(calls.filter((call) => call.url.includes('/admin/reports') && (call.init.method ?? 'GET') === 'GET').length).toBeGreaterThanOrEqual(2);
    });
  });

  it('готовый разбор не предлагает перегенерацию: кнопки нет у строк не-`failed`', async () => {
    const { fetchImpl: fetch, calls } = createFetchLog((url, init) => {
      if ((init.method ?? 'GET') === 'POST') return json({}, 500);
      if (url.includes('/admin/payments')) return json({ items: [], next_cursor: null });
      return json({ items: [report({ status: 'ready', error_code: null }), report({ id: 'x2', status: 'writing', error_code: null })], truncated: false });
    });
    render(<Payments api={api(fetch)} sessionLive demo={false} />);

    await screen.findByText(/Разборы/);
    expect(screen.queryByRole('button', { name: 'Перегенерировать' })).toBeNull();
    expect(posts(calls)).toHaveLength(0);
  });

  it('409 report_not_regenerable — текст сервера, а не зелёная плашка', async () => {
    const { fetchImpl: fetch } = createFetchLog((url, init) => {
      if ((init.method ?? 'GET') === 'POST') {
        return problem(409, 'CONFLICT', 'Перезапускать можно только упавший разбор.', { reason: 'report_not_regenerable' });
      }
      if (url.includes('/admin/payments')) return json({ items: [charge()], next_cursor: null });
      return json({ items: [report()], truncated: false });
    });
    render(<Payments api={api(fetch)} sessionLive demo={false} />);

    await screen.findByRole('button', { name: 'Перегенерировать' });
    pressTwice(/Перегенерировать/);
    const banner = await screen.findByText(/Перезапускать можно только упавший разбор. \(report_not_regenerable\)/);
    // 409 — предупреждение («ты не можешь этого сделать»), не красная авария.
    expect(banner.closest('.banner--warn')).not.toBeNull();
    expect(screen.queryByText(/Разбор снова в очереди/)).toBeNull();
  });

  it('422 с field_errors — строки полей от сервера, а не «что-то пошло не так»', async () => {
    const { fetchImpl: fetch, calls } = createFetchLog((url) => {
      if (url.includes('status=')) {
        return problem(422, 'VALIDATION_FAILED', 'Такого статуса нет', { field_errors: [{ field: 'status', message: 'paid|processed|refunded|failed' }] });
      }
      return json({ items: [charge()], next_cursor: null });
    });
    render(<Payments api={api(fetch)} sessionLive demo={false} />);

    await screen.findByText('chg_9001');
    const charges = panel('Платежи и возвраты');
    fireEvent.change(within(charges).getByLabelText('status'), { target: { value: 'refunded' } });
    fireEvent.click(within(charges).getByRole('button', { name: 'Применить' }));

    expect(await screen.findByText('Ошибка запроса: Такого статуса нет')).toBeInTheDocument();
    // Список полей — текстом сервера: `поле` и `сообщение` рядом, без пересказа.
    const row = screen.getByText(/paid\|processed\|refunded\|failed/);
    expect(row.tagName).toBe('LI');
    expect(row.textContent).toBe('status: paid|processed|refunded|failed');
    expect(screen.getByText(/^VALIDATION_FAILED/)).toBeInTheDocument();

    // Диапазон `limit` панель соблюдает сама: 999 в запрос не уходит, чужой
    // 422 мы не создаём.
    fireEvent.change(within(charges).getByLabelText('limit (1..100)'), { target: { value: '999' } });
    fireEvent.click(within(charges).getByRole('button', { name: 'Применить' }));
    await waitFor(() => {
      expect(calls.filter((call) => call.url.includes('limit=999'))).toHaveLength(0);
    });
  });
});
