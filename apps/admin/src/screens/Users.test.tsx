/*
 * «Пользователи». Проверяем три вещи, за которые на этом экране больно:
 *   • поиск уходит ровно одним параметром (два — серверный 422, и панель его
 *     сама не создаёт);
 *   • возврат звёзд не имеет поля «сколько»: сумму считает сервер, экран её
 *     показывает, а человек повторяет — тело `POST` это и фиксируется;
 *   • блокировка без основания не отправляется.
 * Плюс прод-режим: без ДЕМО экран не дёргает `/admin/users*` вовсе.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAdminApi } from '../api/admin';
import { createHttp } from '../api/http';
import { createFetchLog, header, jsonBody, only, type Call } from '../testing/fetchLog';
import type { AdminUserCard, AdminUserRow } from '../api/types';
import { Users } from './Users';

const NOW = Date.UTC(2026, 10, 20, 12, 0, 0);
const DAY = 86_400_000;
const USER = '2b1f7a04-9d3c-4e21-8a55-000000000001';

const row = (overrides: Partial<AdminUserRow> = {}): AdminUserRow => ({
  user_id: USER,
  tg_id: '777003',
  alias: 'anna_chart',
  name: 'Анна (вымышленная)',
  plan_code: 'month_399',
  access_until: new Date(NOW + 21 * DAY).toISOString(),
  banned: false,
  ...overrides,
});

const card = (overrides: Partial<AdminUserCard> = {}): AdminUserCard => ({
  user_id: USER,
  tg_id: '777003',
  alias: 'anna_chart',
  name: 'Анна (вымышленная)',
  created_at: new Date(NOW - 120 * DAY).toISOString(),
  last_seen_at: new Date(NOW - 3 * 3_600_000).toISOString(),
  push_enabled: true,
  banned_at: null,
  ban_reason: null,
  subscription: { plan_code: 'month_399', until: new Date(NOW + 21 * DAY).toISOString(), source: 'payment' },
  payments: [
    { id: 'pay-1', charge_id: 'chg_9001', kind: 'payment', stars: 399, at: new Date(NOW - 9 * DAY).toISOString(), refunded: false },
  ],
  refundable: { charge_id: 'chg_9001', amount_stars: 399, currency: 'XTR' },
  ...overrides,
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

function respondWith(body: unknown, status = 200, contentType = 'application/json'): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': contentType } });
}

const posts = (calls: readonly Call[]): Call[] => calls.filter((call) => call.init.method === 'POST');

/** Вводит запрос в форму и жмёт «Искать»; radio-режим — если задан. */
function search(mode: 'telegram_id' | 'alias' | 'q', value: string) {
  if (mode !== 'telegram_id') {
    fireEvent.click(screen.getByLabelText(mode === 'alias' ? '@username' : 'текстом'));
  }
  const input = document.querySelector('fieldset input[type="text"]');
  if (!(input instanceof HTMLInputElement)) throw new Error('поле поиска не отрисовано');
  fireEvent.change(input, { target: { value } });
  fireEvent.click(screen.getByRole('button', { name: 'Искать' }));
}

/** Два нажатия HoldConfirm с паузой, сдвинутой mocked `Date.now`. */
function pressTwice(name: RegExp) {
  fireEvent.click(screen.getByRole('button', { name }));
  vi.mocked(Date.now).mockReturnValue(NOW + 2_100);
  fireEvent.click(screen.getByRole('button', { name: /Подожди ещё|Подтвердить ещё раз/ }));
}

describe('Пользователи', () => {
  beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('поиск уходит ровно одним параметром — тем, который выбран', async () => {
    const { fetchImpl: fetch, calls } = createFetchLog((url) =>
      url.includes('/admin/users?') ? respondWith({ items: [row()] }) : respondWith({ items: [] }),
    );
    render(<Users api={api(fetch)} sessionLive demo />);

    search('telegram_id', '777003');
    await waitFor(() => {
      expect(screen.getByText('Анна (вымышленная)')).toBeInTheDocument();
    });
    let query = only(calls.filter((call) => call.url.includes('/admin/users?')), 'поиск по telegram_id').url;
    expect(query).toContain('telegram_id=777003');
    expect(query).not.toContain('alias=');
    expect(query).not.toContain('q=');

    search('alias', '@anna_chart');
    await waitFor(() => {
      expect(calls.filter((call) => call.url.includes('/admin/users?')).length).toBe(2);
    });
    query = calls.filter((call) => call.url.includes('/admin/users?'))[1]?.url ?? '';
    expect(query).toContain('alias=anna_chart');
    expect(query).not.toContain('telegram_id=');
  });

  it('буквы в telegram_id отбиваются до запроса', () => {
    const { fetchImpl: fetch, calls } = createFetchLog(() => respondWith({ items: [] }));
    render(<Users api={api(fetch)} sessionLive demo />);

    const input = document.querySelector('fieldset input[type="text"]');
    if (!(input instanceof HTMLInputElement)) throw new Error('поле поиска не отрисовано');
    fireEvent.change(input, { target: { value: '77a03' } });

    expect(screen.getByText('telegram_id — только цифры')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Искать' })).toBeDisabled();
    expect(calls).toHaveLength(0);
  });

  it('пустой результат — «не нашли», а не «ошибка»', async () => {
    const { fetchImpl: fetch } = createFetchLog(() => respondWith({ items: [] }));
    render(<Users api={api(fetch)} sessionLive demo />);

    search('q', 'нет такого');
    expect(await screen.findByText('Никого не нашли. Поиск не чинит опечатку сам.')).toBeInTheDocument();
  });

  it('карточка: сумма возврата — серверная, и в POST её поля нет', async () => {
    const body = card();
    const { fetchImpl: fetch, calls } = createFetchLog((url, init) => {
      if (init.method === 'POST' && url.includes('/refund')) {
        return respondWith({ charge_id: 'chg_9001', amount_stars: 399, currency: 'XTR', status: 'refunded' });
      }
      if (url.includes('/admin/users/')) return respondWith(body);
      return respondWith({ items: [row()] });
    });
    render(<Users api={api(fetch)} sessionLive demo />);

    search('telegram_id', '777003');
    fireEvent.click(await screen.findByRole('button', { name: 'Открыть карточку' }));

    // Сумму показывает экран, и она серверная: 399 ⭐ — и в строке платежа,
    // и в котировке возврата. Одно число в двух местах — это и есть «сервер
    // посчитал, панель не пересчитывала».
    const amounts = await screen.findAllByText(/399 ⭐/);
    expect(amounts.length).toBeGreaterThanOrEqual(2);
    // Второе поле с числом одно — эхо-подтверждение. Поля «сколько вернуть» нет.
    expect(screen.getByText(/Сумму считает сервер/)).toBeInTheDocument();
    expect(document.querySelectorAll('input[type="number"]')).toHaveLength(0);

    fireEvent.change(screen.getByLabelText(/Повтори сумму \(399\)/), { target: { value: '100' } });
    expect(screen.getByText('Введённая сумма не совпадает с серверной.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Вернуть звёзды' })).toBeDisabled();

    fireEvent.change(screen.getByLabelText(/Основание для возврата/), { target: { value: 'обращение 4211' } });
    fireEvent.change(screen.getByLabelText(/Повтори сумму \(399\)/), { target: { value: '399' } });
    pressTwice(/Вернуть звёзды/);

    await waitFor(() => {
      expect(posts(calls).some((call) => call.url.includes('/refund'))).toBe(true);
    });
    const refund = only(calls.filter((call) => call.url.includes('/refund')), 'POST возврата');
    expect(refund.url).toContain(`/api/v1/admin/users/${USER}/refund`);
    expect(header(refund, 'X-Admin-CSRF')).toBe('токен');
    const sent = jsonBody(refund);
    expect(sent).toEqual({ reason: 'обращение 4211' });
    expect(sent).not.toHaveProperty('amount_stars');
    expect(sent).not.toHaveProperty('amount');
    // Ответ показан целиком, и карточка перечитана — возврат не «тихая галочка».
    expect(await screen.findByText(/Возврат проведён.*refunded/s)).toBeInTheDocument();
    await waitFor(() => {
      expect(calls.filter((call) => call.url.includes(`/admin/users/${USER}`) && (call.init.method ?? 'GET') === 'GET').length).toBeGreaterThanOrEqual(2);
    });
  });

  it('возвращать нечего — формы возврата нет, есть explanation серверного состояния', async () => {
    const { fetchImpl: fetch } = createFetchLog((url) =>
      url.includes('/admin/users/') ? respondWith(card({ refundable: null, payments: [] })) : respondWith({ items: [row()] }),
    );
    render(<Users api={api(fetch)} sessionLive demo />);

    search('telegram_id', '777003');
    fireEvent.click(await screen.findByRole('button', { name: 'Открыть карточку' }));

    expect(await screen.findByText('Возвращать нечего: нет оплаченного платежа без возврата.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Вернуть звёзды' })).toBeNull();
  });

  it('блокировка без основания не отправляется; с основанием — POST с причиной и без поля суммы', async () => {
    const { fetchImpl: fetch, calls } = createFetchLog((url, init) => {
      if (init.method === 'POST') {
        return respondWith({ user_id: USER, banned: true, reason: 'спам', at: new Date(NOW).toISOString() });
      }
      if (url.includes('/admin/users/')) return respondWith(card());
      return respondWith({ items: [row()] });
    });
    render(<Users api={api(fetch)} sessionLive demo />);

    search('telegram_id', '777003');
    fireEvent.click(await screen.findByRole('button', { name: 'Открыть карточку' }));

    const banButton = await screen.findByRole('button', { name: 'Заблокировать' });
    expect(banButton).toBeDisabled();
    expect(posts(calls)).toHaveLength(0);

    fireEvent.change(screen.getByLabelText(/Основание блокировки/), { target: { value: 'спам' } });
    pressTwice(/Заблокировать/);

    await waitFor(() => {
      expect(posts(calls).some((call) => call.url.includes('/ban'))).toBe(true);
    });
    const ban = only(calls.filter((call) => call.url.includes('/ban')), 'POST блокировки');
    expect(jsonBody(ban)).toEqual({ reason: 'спам' });
    expect(header(ban, 'X-Admin-CSRF')).toBe('токен');
  });

  it('пуш — одно нажатие с CSRF-заголовком, карточка перечитана', async () => {
    const { fetchImpl: fetch, calls } = createFetchLog((url, init) => {
      if (init.method === 'POST') return respondWith({ user_id: USER, push_enabled: false });
      if (url.includes('/admin/users/')) return respondWith(card());
      return respondWith({ items: [row()] });
    });
    render(<Users api={api(fetch)} sessionLive demo />);

    search('telegram_id', '777003');
    fireEvent.click(await screen.findByRole('button', { name: 'Открыть карточку' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Выключить пуш' }));

    await waitFor(() => {
      expect(posts(calls)).toHaveLength(1);
    });
    const push = only(posts(calls), 'POST пуша');
    expect(jsonBody(push)).toEqual({ enabled: false });
    expect(header(push, 'X-Admin-CSRF')).toBe('токен');
  });

  it('сервер отказал 409 на возврат — текст сервера на экране, а не «готово»', async () => {
    const { fetchImpl: fetch } = createFetchLog((url, init) => {
      if (init.method === 'POST' && url.includes('/refund')) {
        return respondWith({ code: 'CONFLICT', message: 'Возвращать нечего: оплаченного платежа без возврата нет.', request_id: 'r-9', details: { reason: 'nothing_to_refund' } }, 409, 'application/problem+json');
      }
      if (url.includes('/admin/users/')) return respondWith(card());
      return respondWith({ items: [row()] });
    });
    render(<Users api={api(fetch)} sessionLive demo />);

    search('telegram_id', '777003');
    fireEvent.click(await screen.findByRole('button', { name: 'Открыть карточку' }));
    await screen.findByText(/Сумму считает сервер/); // карточка отрисована — дальше не гонимся
    fireEvent.change(screen.getByLabelText(/Основание для возврата/), { target: { value: 'проверка' } });
    fireEvent.change(screen.getByLabelText(/Повтори сумму \(399\)/), { target: { value: '399' } });
    pressTwice(/Вернуть звёзды/);

    expect(await screen.findByText(/Возвращать нечего.*nothing_to_refund/s)).toBeInTheDocument();
    expect(screen.queryByText(/Возврат проведён/)).toBeNull();
  });

  it('нет маршрутов и нет ДЕМО: экран не дёргает сервер и перечисляет ожидание', async () => {
    const { fetchImpl: fetch, calls } = createFetchLog(() => respondWith({ items: [row()] }));
    render(<Users api={api(fetch, false)} sessionLive demo={false} />);

    search('telegram_id', '777003');
    expect(await screen.findByText('Недоступно в этой версии')).toBeInTheDocument();
    expect(screen.getAllByText('GET /api/v1/admin/users').length).toBeGreaterThan(0);
    expect(calls).toHaveLength(0);
  });
});
