/*
 * «Основатели и партнёры». Маршруты свежие (`/admin/founders`, `/admin/partners`
 * пришли в 1.6.17), поэтому здесь проверяется в первую очередь честность
 * показа чужих агрегатов:
 *   • колонки «ник» нет — поля `username` в `AdminFounder` с 1.6.18 не
 *     существует, человека панель называет `telegram_id`;
 *   • `null` и 0 выглядят по-разному: `expires_at: null` — «—», а не «истекло»,
 *     `last_activation_at: null` у партнёра — «код раздавали, никто не пришёл»;
 *   • фильтр `limit` вне диапазона 1..100 не уходит вовсе: чужого 422 панель
 *     не провоцирует;
 *   • листание — только `next_cursor`: «страниц №3» в контракте нет;
 *   • партнёрский отчёт не становится списком клиентов: идентификаторов
 *     людей и самих кодов в таблице нет.
 */

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAdminApi } from '../api/admin';
import { createHttp } from '../api/http';
import { createFetchLog, jsonResponse, only, problemResponse } from '../testing/fetchLog';
import type { AdminFounder, AdminPartner } from '../api/types';
import { Founders } from './Founders';

const NOW = Date.UTC(2026, 10, 20, 12, 0, 0);
const DAY = 86_400_000;
const iso = (offsetMs: number): string => new Date(NOW + offsetMs).toISOString();

const founder = (overrides: Partial<AdminFounder> = {}): AdminFounder => ({
  place: 1,
  user_id: '2b1f7a04-9d3c-4e21-8a55-000000000001',
  telegram_id: '@700000001',
  created_at: iso(-30 * DAY),
  grant_kind: 'all_access',
  expires_at: iso(30 * DAY),
  code_activated: true,
  ...overrides,
});

const partner = (overrides: Partial<AdminPartner> = {}): AdminPartner => ({
  partner_name: 'leaflet-2026',
  codes_total: 20,
  activations_total: 12,
  activated_users: 11,
  paid_users: 3,
  revenue_stars: 1197,
  last_activation_at: iso(-2 * DAY),
  ...overrides,
});

function api(fetchImpl: typeof fetch): ReturnType<typeof createAdminApi> {
  return createAdminApi(createHttp({ fetchImpl, retries: 0, retryDelayMs: () => 0, csrfToken: () => 'токен' }));
}

/** Ответы двух лент; `partners` намеренно отдельно — отказ одной панели не должен гасить другую. */
function feeds(founders: readonly AdminFounder[] = [founder()], cursor: string | null = null, partners: readonly AdminPartner[] = [partner()]) {
  return createFetchLog((url) => {
    if (url.includes('/admin/founders')) return jsonResponse({ items: founders, next_cursor: cursor });
    if (url.includes('/admin/partners')) return jsonResponse({ items: partners });
    return jsonResponse({ items: [] });
  });
}

/** Панель по заголовку: фильтр `limit` и кнопка «Применить» на экране не уникальны. */
function panel(title: string): HTMLElement {
  const heading = screen.getByRole('heading', { level: 2, name: title });
  const section = heading.closest('section');
  if (section === null) throw new Error(`панель «${title}» не отрисована`);
  return section;
}

const foundersRequests = (calls: readonly { url: string }[]): string[] =>
  calls.filter((call) => call.url.includes('/admin/founders')).map((call) => call.url);

describe('Основатели и партнёры', () => {
  beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('limit уходит фильтром, а значение вне 1..100 не уходит вовсе', async () => {
    const { fetchImpl: fetch, calls } = feeds();
    render(<Founders api={api(fetch)} sessionLive demo={false} />);

    await screen.findByText('@700000001');
    // Первая загрузка — без фильтра: сервер сам решает, сколько строк дать.
    expect(only(foundersRequests(calls), 'первый запрос мест')).not.toContain('limit=');

    const places = panel('Места первых 50');
    fireEvent.change(within(places).getByLabelText('limit (1..100)'), { target: { value: '20' } });
    fireEvent.click(within(places).getByRole('button', { name: 'Применить' }));
    await waitFor(() => {
      expect(foundersRequests(calls).some((url) => url.includes('limit=20'))).toBe(true);
    });

    // 0 и 101 — это 422 от сервера; панель предпочитает не отправлять поле.
    fireEvent.change(within(places).getByLabelText('limit (1..100)'), { target: { value: '0' } });
    fireEvent.click(within(places).getByRole('button', { name: 'Применить' }));
    await waitFor(() => {
      const last = foundersRequests(calls).at(-1);
      expect(last).toBeDefined();
      expect(last ?? '').not.toContain('limit=0');
    });
  });

  it('колонки «ник» нет: человека называет telegram_id, а не выдуманный username', async () => {
    const { fetchImpl: fetch } = feeds();
    render(<Founders api={api(fetch)} sessionLive demo={false} />);

    await screen.findByText('@700000001');
    const places = panel('Места первых 50');
    expect(within(places).queryByText('Ник')).toBeNull();
    expect(within(places).queryByText('username')).toBeNull();
    expect(within(places).getByText('Telegram ID')).toBeInTheDocument();
    // Причина отсутствия колонки сказана на экране, а не спрятана в коде.
    expect(within(places).getByText(/Колонки «ник» нет/)).toBeInTheDocument();
  });

  it('null и 0 различимы: expires_at — «—», права нет, человек пришёл сам', async () => {
    const { fetchImpl: fetch } = feeds([
      founder({ place: 2, grant_kind: null, expires_at: null, code_activated: false, telegram_id: '@700000002' }),
      founder({ place: 3, grant_kind: 'single_report', expires_at: iso(-5 * DAY), code_activated: true, telegram_id: '@700000003' }),
    ]);
    render(<Founders api={api(fetch)} sessionLive demo={false} />);

    const places = panel('Места первых 50');
    await within(places).findByText('@700000002');
    expect(within(places).getByText('права нет')).toBeInTheDocument();
    expect(within(places).getByText('сам')).toBeInTheDocument();
    // «истекло» про `expires_at: null` было бы враньём: права не было вовсе.
    // «истекло» про `expires_at: null` было бы враньём: права не было вовсе.
    expect(within(places).getAllByText('—').length).toBeGreaterThanOrEqual(1);
    // А вот право, у которого срок прошёл, показано датой — её видно.
    expect(within(places).getByText('15.11.2026, 12:00')).toBeInTheDocument();
  });

  it('пустой список — «мест ещё никто не занял», а не ошибка и не нули', async () => {
    const { fetchImpl: fetch } = feeds([], null, []);
    render(<Founders api={api(fetch)} sessionLive demo={false} />);

    expect(await screen.findByText('Мест ещё никто не занял.')).toBeInTheDocument();
    expect(screen.getByText('Партнёрских кодов нет.')).toBeInTheDocument();
    expect(screen.queryByText(/Ошибка запроса/)).toBeNull();
    // Таблицы с заголовками и строкой «0» нет: пустота названа пустотой.
    expect(screen.queryAllByRole('row').filter((row) => row.textContent === '0')).toHaveLength(0);
  });

  it('курсор: next_cursor назван, «Показать ещё» по номеру страницы не появляется', async () => {
    const { fetchImpl: fetch, calls } = feeds([founder()], '50');
    render(<Founders api={api(fetch)} sessionLive demo={false} />);

    const places = panel('Места первых 50');
    await within(places).findByText('@700000001');
    expect(within(places).getByText(/Страницы — только по курсору сервера/)).toBeInTheDocument();
    expect(within(places).queryByText(/Дальше страниц нет/)).toBeNull();
    // И «второй страницы» панель не выдумывает: запрос был ровно один.
    expect(foundersRequests(calls)).toHaveLength(1);
  });

  it('партнёры: 0 активаций — это ответ; доход подписан «без учёта возвратов»', async () => {
    const { fetchImpl: fetch } = feeds([founder()], null, [
      partner({ last_activation_at: null, activations_total: 0, activated_users: 0, paid_users: 0, revenue_stars: 0 }),
    ]);
    render(<Founders api={api(fetch)} sessionLive demo={false} />);

    const partners = panel('Партнёры');
    const row = await within(partners).findByText('leaflet-2026');
    expect(row.closest('tr')?.textContent).toContain('Код раздавали, никто не пришёл');
    // Нули остаются нулями: «—» здесь читалось бы как «данных нет».
    expect(within(partners).getAllByText('0')).toHaveLength(4);
    expect(within(partners).getByText(/без учёта возвратов/)).toBeInTheDocument();
    // Ни кодов, ни идентификаторов людей: отчёт партнёра — не список клиентов.
    expect(within(partners).queryByText(/2b1f7a04/)).toBeNull();
    expect(within(partners).queryByText(/K7M2P9X4/)).toBeNull();
  });

  it('403 на партнёрах не гасит места: отказ показан текстом сервера в своей панели', async () => {
    const { fetchImpl: fetch } = createFetchLog((url) => {
      if (url.includes('/admin/partners')) {
        return problemResponse(403, 'FORBIDDEN', 'Нужен ADMIN_TG_ID — этот список только для владельца.', {
          reason: 'not_owner',
        });
      }
      return jsonResponse({ items: [founder()], next_cursor: null });
    });
    render(<Founders api={api(fetch)} sessionLive demo={false} />);

    // Место видно: вторая панель не превращается в «данных нет».
    await screen.findByText('@700000001');
    const partners = panel('Партнёры');
    expect(await within(partners).findByText(/Нужен ADMIN_TG_ID — этот список только для владельца./)).toBeInTheDocument();
    expect(within(partners).getByText(/not_owner/)).toBeInTheDocument();
    // Соседняя панель не «заразилась» отказом: свои места на месте.
    expect(within(panel('Места первых 50')).queryByText(/Нет доступа/)).toBeNull();
  });

  it('без сессии лента не читается: ни одного запроса к обоим маршрутам', () => {
    const { fetchImpl: fetch, calls } = feeds();
    render(<Founders api={api(fetch)} sessionLive={false} demo={false} />);

    expect(calls).toHaveLength(0);
  });
});
