/*
 * Проверки экрана «Коды и гранты» — по главному правилу панели: ни одно
 * необратимое действие не выполняется без второго шага, и ни один список не
 * рисуется, если сервер его не отдал.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAdminApi } from '../api/admin';
import { createHttp } from '../api/http';
import { createFetchLog, header, jsonBody, nth, only, type Call } from '../testing/fetchLog';
import { Codes } from './Codes';
import type { AccessCode, GrantRow } from '../api/types';

const NOW = Date.UTC(2026, 10, 20, 12, 0, 0);
const USER = '2b1f7a04-9d3c-4e21-8a55-000000000001';
const DAY = 86_400_000;

function code(overrides: Partial<AccessCode> = {}): AccessCode {
  return {
    id: 'c1',
    code: 'K7M2P9X4',
    kind: 'all_access',
    days: 30,
    max_activations: 10,
    activations: 3,
    partner_name: 'партнёр',
    is_active: true,
    expires_at: null,
    created_at: new Date(NOW - DAY).toISOString(),
    ...overrides,
  };
}

function grant(overrides: Partial<GrantRow> = {}): GrantRow {
  return {
    id: 'g1',
    user_id: USER,
    kind: 'all_access',
    source: 'founder',
    code_id: null,
    days: 30,
    starts_at: new Date(NOW - 5 * DAY).toISOString(),
    expires_at: new Date(NOW + 25 * DAY).toISOString(),
    consumed_at: null,
    revoked_at: null,
    revoked: false,
    created_at: new Date(NOW - 5 * DAY).toISOString(),
    ...overrides,
  };
}

/**
 * Стаб отвечает по URL, вызовы пишутся в `calls`: проверять надо ровно их, а не
 * «последний запрос», потому что после POST панель перечитывает список, и
 * последний вызов — это уже GET.
 */
const stub = createFetchLog;

function api(fetchImpl: typeof fetch): ReturnType<typeof createAdminApi> {
  return createAdminApi(createHttp({ fetchImpl, csrfToken: () => 'токен' }));
}

const responses = {
  list(items: readonly unknown[]) {
    return new Response(JSON.stringify({ items }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  },
  codes(items: readonly AccessCode[]) {
    return this.list(items);
  },
  grants(items: readonly GrantRow[]) {
    return this.list(items);
  },
  problem(status: number, code: string, message: string, details?: unknown) {
    return new Response(JSON.stringify({ code, message, request_id: 'r', ...(details ? { details } : {}) }), {
      status,
      headers: { 'Content-Type': 'application/problem+json' },
    });
  },
};

const posts = (calls: readonly Call[]): Call[] => calls.filter((call) => call.init.method === 'POST');
const grantsCalls = (calls: readonly Call[]): Call[] => calls.filter((call) => call.url.includes('/admin/grants'));

describe('Коды и гранты', () => {
  beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('не дёргает приватные маршруты без сессии', async () => {
    const { fetchImpl: fetch, calls } = stub(() => responses.codes([code()]));
    render(<Codes api={api(fetch)} sessionLive={false} now={NOW} />);

    await waitFor(() => { expect(screen.getAllByText(/Сессии нет/).length).toBeGreaterThan(0); });
    expect(calls).toHaveLength(0);
  });

  it('рисует список кодов из ответа сервера', async () => {
    const { fetchImpl: fetch } = stub((url) =>
      url.includes('/admin/codes')
        ? responses.codes([code(), code({ id: 'c2', code: 'QWERTY23', activations: 5, max_activations: 5, partner_name: null })])
        : responses.grants([]),
    );

    render(<Codes api={api(fetch)} sessionLive now={NOW} />);

    expect(await screen.findByText('K7M2P9X4')).toBeInTheDocument();
    expect(screen.getByText('3 из 10')).toBeInTheDocument();
    expect(screen.getByText('активен')).toBeInTheDocument();
    // Лимит выбран целиком — это видно без догадок: состояние взято из счётчиков.
    expect(screen.getByText('лимит выбран')).toBeInTheDocument();
    expect(screen.getAllByText('партнёр')).toHaveLength(1);
  });

  it('пустой список — это «пусто», а не таблица с нулями', async () => {
    const { fetchImpl: fetch } = stub(() => responses.codes([]));
    render(<Codes api={api(fetch)} sessionLive now={NOW} />);

    expect(await screen.findByText('Последние коды')).toBeInTheDocument();
    expect(screen.getByText('Кодов ещё нет.')).toBeInTheDocument();
    expect(screen.queryByText('из')).toBeNull();
  });

  it('история грантов не запрашивается без user_id', async () => {
    const { fetchImpl: fetch, calls } = stub((url) => (url.includes('/admin/codes') ? responses.codes([]) : responses.grants([])));
    render(<Codes api={api(fetch)} sessionLive now={NOW} />);

    expect(await screen.findByText('Нужен user_id — без него сервер отвечает 422, а не пустым списком.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Показать историю' })).toBeDisabled();

    fireEvent.change(screen.getByLabelText(/user_id \(uuid из карточки\)$/), { target: { value: 'не uuid' } });
    expect(screen.getByRole('button', { name: 'Показать историю' })).toBeDisabled();
    expect(grantsCalls(calls)).toHaveLength(0);
  });

  it('показывает историю по uuid и оставляет отозванное право видимым', async () => {
    const { fetchImpl: fetch, calls } = stub((url) =>
      url.includes('/admin/codes')
        ? responses.codes([])
        : responses.grants([grant(), grant({ id: 'g2', kind: 'single_report', source: 'purchase', revoked: true, revoked_at: new Date(NOW).toISOString() })]),
    );

    render(<Codes api={api(fetch)} sessionLive now={NOW} />);

    fireEvent.change(screen.getByLabelText(/user_id \(uuid из карточки\)$/), { target: { value: USER } });
    fireEvent.click(screen.getByRole('button', { name: 'Показать историю' }));

    // Право в истории подписано источником: его никто в списке кодов не рисовал.
    expect(await screen.findByText('право основателя')).toBeInTheDocument();
    // Отозванное право остаётся в списке как история — и без кнопки отзыва.
    expect(screen.getAllByText(/отозван/i).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('button', { name: 'Отозвать' })).toHaveLength(1);
    expect(grantsCalls(calls)).toHaveLength(1);
    expect(only(grantsCalls(calls), 'запрос истории грантов').url).toContain(`user_id=${USER}`);
  });

  it('отзыв права требует второго нажатия: одно нажатие не отправляет POST', async () => {
    const { fetchImpl: fetch, calls } = stub((url) => (url.includes('/admin/grants') ? responses.grants([grant()]) : responses.codes([])));

    render(<Codes api={api(fetch)} sessionLive now={NOW} />);
    fireEvent.change(screen.getByLabelText(/user_id \(uuid из карточки\)$/), { target: { value: USER } });
    fireEvent.click(screen.getByRole('button', { name: 'Показать историю' }));

    fireEvent.click(await screen.findByRole('button', { name: 'Отозвать' }));

    const confirm = await screen.findByRole('button', { name: 'Подтвердить отзыв' });
    // Первое нажатие — «вооружить». POST быть не должно.
    fireEvent.click(confirm);
    expect(posts(calls)).toHaveLength(0);

    // Второе — только после паузы: сдвигаем часы, не дожидаясь реальных двух секунд.
    vi.mocked(Date.now).mockReturnValue(NOW + 2_100);
    fireEvent.click(screen.getByRole('button', { name: /Подожди ещё/ }));

    await waitFor(() => { expect(posts(calls)).toHaveLength(1); });
    const revokeCall = only(posts(calls), 'POST на отзыв');
    expect(jsonBody(revokeCall)).toMatchObject({ action: 'revoke', grant_id: 'g1', user_id: USER });
    expect(header(revokeCall, 'X-Admin-CSRF')).toBe('токен');
    // Отзыв не удаляет строку: историю перечитывают, а не выкидывают из списка.
    expect(grantsCalls(calls).filter((call) => call.init.method === 'GET').length).toBeGreaterThanOrEqual(2);
  });

  it('создаёт пакет по одному запросу и честно сообщает об остановке на середине', async () => {
    let created = 0;
    const { fetchImpl: fetch, calls } = stub((url, init) => {
      if (url.includes('/admin/codes') && init.method === 'POST') {
        created += 1;
        if (created === 3) {
          return responses.problem(503, 'BONUS_BUDGET_EXHAUSTED', 'Бюджет бесплатного доступа исчерпан.', { reason: 'bonus_budget_exhausted' });
        }
        return new Response(JSON.stringify(code({ id: `new-${created}`, code: `CODE${created}` })), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return responses.codes([]);
    });

    render(<Codes api={api(fetch)} sessionLive now={NOW} />);

    fireEvent.change(screen.getByLabelText('Сколько кодов'), { target: { value: '5' } });
    fireEvent.change(screen.getByLabelText('Партнёр (метка, не ПДн)'), { target: { value: 'подкаст' } });
    fireEvent.click(screen.getByRole('button', { name: 'Создать' }));

    expect(await screen.findByText('Создано не всё')).toBeInTheDocument();
    // Остановились на третьем: два кода созданы и показаны, третий — нет.
    expect(screen.getByText('CODE1')).toBeInTheDocument();
    expect(screen.getByText('CODE2')).toBeInTheDocument();
    expect(screen.queryByText('CODE3')).toBeNull();
    expect(screen.getByText(/Бюджет бесплатного доступа исчерпан/)).toBeInTheDocument();
    expect(created).toBe(3);
    // Каждый POST — отдельный код, и тело не содержит «пакетом N штук».
    expect(posts(calls)).toHaveLength(3);
    expect(jsonBody(nth(posts(calls), 0, 'первый POST кода'))).toMatchObject({ kind: 'single_report', partner_name: 'подкаст' });
  });

  it('не отправляет POST, когда для all_access не указаны дни', async () => {
    const { fetchImpl: fetch, calls } = stub((url, init) =>
      url.includes('/admin/codes') && init.method === 'POST' ? responses.problem(400, 'VALIDATION_FAILED', 'Не должно случиться') : responses.codes([]),
    );

    render(<Codes api={api(fetch)} sessionLive now={NOW} />);
    await screen.findByText('Последние коды');
    fireEvent.change(screen.getByLabelText('Какое право'), { target: { value: 'all_access' } });
    fireEvent.change(screen.getByLabelText('Дней доступа'), { target: { value: '' } });

    expect(screen.getByRole('button', { name: 'Создать' })).toBeDisabled();
    expect(posts(calls)).toHaveLength(0);
  });

  it('выдача права: чужой формат user_id не отправляется, uuid — уходит одним POST', async () => {
    const { fetchImpl: fetch, calls } = stub(() => responses.codes([]));
    render(<Codes api={api(fetch)} sessionLive now={NOW} />);

    const field = screen.getByLabelText(/user_id получателя/);
    fireEvent.change(field, { target: { value: '42' } });
    expect(screen.getByRole('button', { name: 'Выдать' })).toBeDisabled();

    // Одно право живёт не в днях: поле срока панель не показывает и дней не
    // отправляет — сервер на них и не смотрит.
    expect(screen.queryByLabelText('Дней')).toBeNull();
    fireEvent.change(field, { target: { value: USER } });
    expect(screen.getByRole('button', { name: 'Выдать' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Выдать' }));

    await waitFor(() => { expect(posts(calls)).toHaveLength(1); });
    const issued = only(posts(calls), 'POST выдачи');
    expect(jsonBody(issued)).toMatchObject({ user_id: USER, kind: 'single_report' });
    expect(jsonBody(issued)).not.toHaveProperty('days');
    expect(await screen.findByText(/Право выдано/)).toBeInTheDocument();

    // А для «всё включено» срок обязателен: без него POST не уходит.
    fireEvent.change(screen.getByLabelText('Право'), { target: { value: 'all_access' } });
    fireEvent.change(screen.getByLabelText('Дней'), { target: { value: '0' } });
    expect(screen.getByRole('button', { name: 'Выдать' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Дней'), { target: { value: '90' } });
    fireEvent.click(screen.getByRole('button', { name: 'Выдать' }));
    await waitFor(() => { expect(posts(calls)).toHaveLength(2); });
    expect(jsonBody(nth(posts(calls), 1, 'POST выдачи «всё включено»'))).toMatchObject({ kind: 'all_access', days: 90 });
  });

  it('маршруты вне контракта не дёргаются даже по клику: 404 показан как «нет маршрута»', async () => {
    const { fetchImpl: fetch, calls } = stub((url, init) =>
      url.includes('/admin/codes') && init.method === 'POST' ? responses.problem(404, 'NOT_FOUND', 'Такой страницы нет.') : responses.codes([]),
    );
    render(<Codes api={api(fetch)} sessionLive now={NOW} />);

    fireEvent.click(screen.getByRole('button', { name: 'Создать' }));

    expect(await screen.findByText(/Такой страницы нет/)).toBeInTheDocument();
    expect(calls.length).toBeLessThan(4);
  });
});
