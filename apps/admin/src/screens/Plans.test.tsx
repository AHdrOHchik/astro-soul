/*
 * «Тарифы» — экран, который меняет чужие деньги. Поэтому проверяется не
 * «красиво ли таблица стоит», а запреты:
 *   • без `comment` запрос не уходит (ответ владельца §4);
 *   • серверный `409 price_changed` не перезаписывает значение — экран
 *     перечитывает каталог;
 *   • `founder_month` не редактируется (ответ владельца §5);
 *   • в проде, где маршрутов `/admin/plans*` нет, экран не дёргает сервер
 *     вовсе и рисует список недостающих адресов, а не «пустой каталог».
 */

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAdminApi } from '../api/admin';
import { createHttp } from '../api/http';
import { createFetchLog, header, jsonBody, only, type Call } from '../testing/fetchLog';
import type { AdminPlanRow } from '../api/types';
import { Plans } from './Plans';

const NOW = Date.UTC(2026, 10, 20, 12, 0, 0);
const DAY = 86_400_000;

const month = (overrides: Partial<AdminPlanRow> = {}): AdminPlanRow => ({
  code: 'month_399',
  title: 'Месяц',
  price_stars: 399,
  discount_price_stars: null,
  is_active: true,
  test_only: false,
  founder_only: false,
  price_change_scope: 'only_new_purchases',
  version: 7,
  updated_at: new Date(NOW - 2 * DAY).toISOString(),
  updated_by_name: 'Владелец',
  updated_by_tg_id: '777001',
  ...overrides,
});

const founder: AdminPlanRow = month({
  code: 'founder_month',
  title: 'Основательский',
  price_stars: 250,
  founder_only: true,
  price_change_scope: '',
  version: 2,
});

function api(fetchImpl: typeof fetch, allowMissing = true): ReturnType<typeof createAdminApi> {
  return createAdminApi(
    createHttp({
      fetchImpl,
      retries: 0,
      retryDelayMs: () => 0,
      csrfToken: () => 'токен',
      allowUnknownRoutes: allowMissing,
    }),
  );
}

const responses = {
  plans(items: readonly AdminPlanRow[]) {
    return new Response(JSON.stringify({ items }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  },
  json(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  },
  problem(status: number, code: string, message: string, details?: unknown) {
    return new Response(JSON.stringify({ code, message, request_id: 'r', ...(details ? { details } : {}) }), {
      status,
      headers: { 'Content-Type': 'application/problem+json' },
    });
  },
};

const patches = (calls: readonly Call[]): Call[] => calls.filter((call) => call.init.method === 'PATCH');
const planGets = (calls: readonly Call[]): Call[] =>
  calls.filter((call) => call.url.includes('/admin/plans') && (call.init.method ?? 'GET') === 'GET');

describe('Тарифы', () => {
  beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('рисует серверные цены и снимок имени из аудита', async () => {
    const { fetchImpl: fetch } = createFetchLog(() => responses.plans([month(), founder]));
    render(<Plans api={api(fetch)} sessionLive demo now={NOW} />);

    expect(await screen.findByText('399')).toBeInTheDocument();
    expect(screen.getByText('250')).toBeInTheDocument();
    // «Кто менял» — снимок в строке плана; отдельного запроса за подписью нет.
    // Имя — снимок в обеих строках: его рисует сама строка плана, отдельного
    // запроса за «кто это» экран не делает (fetch — ровно один, на каталог).
    expect(screen.getAllByText('Владелец').length).toBe(2);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('founder_month не редактируется: кнопка заблокирована с причиной', async () => {
    const { fetchImpl: fetch } = createFetchLog(() => responses.plans([founder]));
    render(<Plans api={api(fetch)} sessionLive demo now={NOW} />);

    const row = (await screen.findByText('Основательский')).closest('tr');
    if (row === null) throw new Error('строка тарифа не отрисована');
    const button = within(row).getByRole('button', { name: 'Изменить цену' });
    expect(button).toBeDisabled();
    expect(button.getAttribute('title')).toMatch(/не может/);
  });

  it('правка без основания не отправляется, а серверное поле `comment` появляется только с текстом', async () => {
    const { fetchImpl: fetch, calls } = createFetchLog((url) =>
      url.includes('/history') ? responses.json({ items: [] }) : responses.plans([month()]),
    );
    render(<Plans api={api(fetch)} sessionLive demo now={NOW} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Изменить цену' }));
    fireEvent.change(screen.getByLabelText('Новая цена, ⭐'), { target: { value: '349' } });
    fireEvent.change(screen.getByLabelText('Повтори новую цену'), { target: { value: '349' } });

    // Основания нет — и кнопка подтверждения недоступна: «сначала скажи зачем».
    expect(screen.getByRole('button', { name: 'Отправить правку' })).toBeDisabled();
    expect(patches(calls)).toHaveLength(0);
  });

  it('эхо не совпало — подтверждения нет; совпало — PATCH с комментарием и версией', async () => {
    const saved = month({ price_stars: 349, version: 8 });
    const { fetchImpl: fetch, calls } = createFetchLog((url, init) => {
      if (init.method === 'PATCH') return responses.json({ plan: saved, audit: auditLine, price_change_scope: saved.price_change_scope });
      if (url.includes('/history')) return responses.json({ items: [] });
      return responses.plans([month()]);
    });
    render(<Plans api={api(fetch)} sessionLive demo now={NOW} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Изменить цену' }));
    fireEvent.change(screen.getByLabelText('Новая цена, ⭐'), { target: { value: '349' } });
    fireEvent.change(screen.getByLabelText('Основание (обязательно, уйдёт в аудит)'), { target: { value: 'акция выходного дня' } });
    fireEvent.change(screen.getByLabelText('Повтори новую цену'), { target: { value: '3490' } });

    expect(screen.getByText('Введённая цена не совпадает с новой.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Отправить правку' })).toBeDisabled();

    fireEvent.change(screen.getByLabelText('Повтори новую цену'), { target: { value: '349' } });
    fireEvent.click(screen.getByRole('button', { name: 'Отправить правку' }));
    expect(patches(calls)).toHaveLength(0); // первое нажатие только вооружает

    vi.mocked(Date.now).mockReturnValue(NOW + 2_100);
    fireEvent.click(screen.getByRole('button', { name: /Подожди ещё|Подтвердить ещё раз/ }));
    await waitFor(() => {
      expect(patches(calls)).toHaveLength(1);
    });

    const patch = only(patches(calls), 'PATCH цены');
    expect(patch.url).toContain('/api/v1/admin/plans/month_399');
    expect(header(patch, 'X-Admin-CSRF')).toBe('токен');
    // Тело: только то, что напечатано, плюс обязательное основание и версия строки.
    expect(jsonBody(patch)).toEqual({ price_stars: 349, discount_price_stars: null, comment: 'акция выходного дня', base_version: 7 });
    // Успех: каталог перечитан, редактор закрыт, показан факт из аудита.
    await waitFor(() => {
      expect(planGets(calls).length).toBeGreaterThanOrEqual(2);
    });
    expect(await screen.findByText(/Цена обновлена/)).toBeInTheDocument();
  });

  it('409 price_changed: перечитать и показать текущее, а не писать поверх', async () => {
    const current = month({ price_stars: 349, version: 9 });
    const { fetchImpl: fetch, calls } = createFetchLog((url, init) => {
      if (init.method === 'PATCH') {
        return responses.problem(409, 'CONFLICT', 'Тариф изменён другой сессией — показываем текущее значение.', {
          reason: 'price_changed',
          current,
        });
      }
      if (url.includes('/history')) return responses.json({ items: [] });
      // Первый GET отдаёт устаревший снимок (version 7), второй — уже текущий.
      return planGets(calls).length === 0 ? responses.plans([month()]) : responses.plans([current]);
    });
    render(<Plans api={api(fetch)} sessionLive demo now={NOW} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Изменить цену' }));
    fireEvent.change(screen.getByLabelText('Новая цена, ⭐'), { target: { value: '299' } });
    fireEvent.change(screen.getByLabelText('Основание (обязательно, уйдёт в аудит)'), { target: { value: 'своя акция' } });
    fireEvent.change(screen.getByLabelText('Повтори новую цену'), { target: { value: '299' } });
    fireEvent.click(screen.getByRole('button', { name: 'Отправить правку' }));
    vi.mocked(Date.now).mockReturnValue(NOW + 2_100);
    fireEvent.click(screen.getByRole('button', { name: /Подожди ещё|Подтвердить ещё раз/ }));

    expect(await screen.findByText(/Тариф изменили, пока ты набирал цену/)).toBeInTheDocument();
    await waitFor(() => {
      expect(planGets(calls).length).toBeGreaterThanOrEqual(2);
    });
    // Отредактированное значение не «применяется тихо»: форма закрыта, в таблице — серверное.
    expect(screen.queryByLabelText('Новая цена, ⭐')).toBeNull();
    expect(await screen.findByText('349')).toBeInTheDocument();
  });

  it('история тарифа: строка аудита с «было → стало» без похода в users', async () => {
    const { fetchImpl: fetch } = createFetchLog((url) =>
      url.includes('/history')
        ? responses.json({
            items: [
              {
                at: new Date(NOW - 2 * DAY).toISOString(),
                actor_tg_id: '777001',
                actor_name: 'Владелец',
                from_price: 449,
                to_price: 399,
                comment: 'прайс перед пушем',
              },
            ],
          })
        : responses.plans([month()]),
    );
    render(<Plans api={api(fetch)} sessionLive demo now={NOW} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Показать историю' }));
    const comment = await screen.findByText('прайс перед пушем');
    // Считаем по таблице истории: «399» живёт и в каталоге — это цена, не «стало».
    const table = comment.closest('table');
    if (table === null) throw new Error('таблица истории не отрисована');
    expect(within(table).getByText('449')).toBeInTheDocument();
    expect(within(table).getByText('399')).toBeInTheDocument();
  });

  it('нет маршрута в контракте и нет ДЕМО: экран не дёргает сервер и перечисляет, чего ждёт', async () => {
    const { fetchImpl: fetch, calls } = createFetchLog(() => responses.plans([month()]));
    render(<Plans api={api(fetch, false)} sessionLive demo={false} now={NOW} />);

    expect(await screen.findByText('Недоступно в этой версии')).toBeInTheDocument();
    expect(screen.getAllByText('GET /api/v1/admin/plans').length).toBeGreaterThan(0);
    expect(calls).toHaveLength(0);
  });
});

const auditLine = {
  at: new Date(NOW).toISOString(),
  actor_name: 'Владелец',
  actor_tg_id: '777001',
  request_id: 'mock-1',
};
