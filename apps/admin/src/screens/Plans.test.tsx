/*
 * «Тарифы» — экран, который меняет чужие деньги. Поэтому проверяется не
 * «красиво ли таблица стоит», а запреты:
 *   • без `comment` запрос не уходит (поле обязательно контрактом), и кнопка
 *     при пустом основании мертва;
 *   • серверный `409 price_changed` не перезаписывает значение — экран
 *     перечитывает каталог и закрывает редактор;
 *   • цена `founder_month` не правится, а `test_only` на нём — правится;
 *   • снятие `test_only` уезжает с `confirm`, иначе сервер отвечает
 *     `422 confirmation_required`;
 *   • поля «скидка» и «кто менял» на экране нет: в `AdminPlan` этих полей нет.
 */

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAdminApi } from '../api/admin';
import { createHttp } from '../api/http';
import { createFetchLog, header, jsonBody, only, type Call } from '../testing/fetchLog';
import type { AdminPlan, AdminPlanHistoryEntry } from '../api/types';
import { Plans } from './Plans';

const NOW = Date.UTC(2026, 10, 20, 12, 0, 0);
const DAY = 86_400_000;
const iso = (offsetMs: number): string => new Date(NOW + offsetMs).toISOString();

const month = (overrides: Partial<AdminPlan> = {}): AdminPlan => ({
  code: 'month_399',
  kind: 'subscription',
  title: 'Месяц',
  price_stars: 399,
  period_days: 30,
  test_only: false,
  active: true,
  founder_only: false,
  version: 7,
  updated_at: iso(-2 * DAY),
  ...overrides,
});

const founder: AdminPlan = month({
  code: 'founder_month',
  title: 'Основательский',
  price_stars: 250,
  founder_only: true,
  version: 2,
});

const testPlan: AdminPlan = month({
  code: 'test_1',
  title: 'Тестовый',
  price_stars: 1,
  test_only: true,
  active: false,
  kind: 'one_off',
  period_days: undefined,
  version: 1,
});

const historyEntry = (overrides: Partial<AdminPlanHistoryEntry> = {}): AdminPlanHistoryEntry => ({
  id: 'ph-3',
  plan_code: 'month_399',
  price_stars: 399,
  previous_price_stars: 449,
  version: 7,
  comment: 'прайс перед новогодним пушем',
  actor_tg_id: '777001',
  actor_name: 'Владелец',
  effective_from: iso(-2 * DAY),
  created_at: iso(-2 * DAY),
  ...overrides,
});

function api(fetchImpl: typeof fetch, allowMissing = false): ReturnType<typeof createAdminApi> {
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
  plans(items: readonly AdminPlan[]) {
    return new Response(JSON.stringify({ items }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  },
  history(items: readonly AdminPlanHistoryEntry[]) {
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
  calls.filter((call) => call.url.includes('/admin/plans') && (call.init.method ?? 'GET') === 'GET' && !call.url.includes('/history'));

/** Два нажатия HoldConfirm с паузой, сдвинутой mocked `Date.now`. */
function pressTwice(name: RegExp) {
  fireEvent.click(screen.getByRole('button', { name }));
  vi.mocked(Date.now).mockReturnValue(NOW + 2_100);
  fireEvent.click(screen.getByRole('button', { name: /Подожди ещё|Подтвердить ещё раз/ }));
}

describe('Тарифы', () => {
  beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('рисует серверные цены, флаги и версию строки — и ни одного выдуманного поля', async () => {
    const { fetchImpl: fetch, calls } = createFetchLog(() => responses.plans([month(), founder, testPlan]));
    render(<Plans api={api(fetch)} sessionLive demo={false} now={NOW} />);

    expect(await screen.findByText('399')).toBeInTheDocument();
    expect(screen.getByText('250')).toBeInTheDocument();
    // Версия строки — то, чем панель защищается от перезаписи (`base_version`).
    expect(screen.getByText('7')).toBeInTheDocument();
    // Разовый тариф без `period_days` — прочерк, а не «0 дн.».
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
    expect(screen.getByText(/тестовый/)).toBeInTheDocument();
    // «Кто менял» в каталоге не показывается: поля `updated_by_*` в `AdminPlan`
    // нет, и панель не рисует имя, которого ей не прислали.
    expect(screen.queryByText('Владелец')).toBeNull();
    expect(screen.getByText(/Колонки «кто менял» нет/)).toBeInTheDocument();
    expect(planGets(calls)).toHaveLength(1);
  });

  it('founder_month: цена закрыта, редактор открывается и говорит об этом прямо', async () => {
    const { fetchImpl: fetch, calls } = createFetchLog(() => responses.plans([founder]));
    render(<Plans api={api(fetch)} sessionLive demo={false} now={NOW} />);

    const row = (await screen.findByText('Основательский')).closest('tr');
    if (row === null) throw new Error('строка тарифа не отрисована');
    fireEvent.click(within(row).getByRole('button', { name: 'Изменить' }));

    expect(await screen.findByText(/Цена этого тарифа обещана первым 50 людям/)).toBeInTheDocument();
    const priceInput = screen.getByLabelText('Новая цена, ⭐');
    fireEvent.change(priceInput, { target: { value: '199' } });
    fireEvent.change(screen.getByLabelText(/Основание \(обязательно/), { target: { value: 'попробовал' } });
    fireEvent.change(screen.getByLabelText('Повтори новую цену'), { target: { value: '199' } });

    expect(screen.getByText(/Цена основательского тарифа закрыта для панели/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Отправить правку' })).toBeDisabled();
    expect(patches(calls)).toHaveLength(0);
  });

  it('правка без основания не отправляется: кнопка мертва, пока `comment` пуст', async () => {
    const { fetchImpl: fetch, calls } = createFetchLog((url) =>
      url.includes('/history') ? responses.history([]) : responses.plans([month()]),
    );
    render(<Plans api={api(fetch)} sessionLive demo={false} now={NOW} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Изменить' }));
    fireEvent.change(screen.getByLabelText('Новая цена, ⭐'), { target: { value: '349' } });
    // Эхо совпало, цена отличается — и всё равно кнопки нет: без комментария
    // сервер ответил бы 422, а панель этот ответ сама не создаёт.
    fireEvent.change(screen.getByLabelText('Повтори новую цену'), { target: { value: '349' } });
    expect(screen.getByText(/Без основания правка не отправляется/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Отправить правку' })).toBeDisabled();
    expect(patches(calls)).toHaveLength(0);

    fireEvent.change(screen.getByLabelText(/Основание \(обязательно/), { target: { value: 'прайс-лист v3' } });
    expect(screen.getByRole('button', { name: 'Отправить правку' })).toBeEnabled();
  });

  it('цена — ручной ввод: степперов и пересчёта нет; эхо не совпало — подтверждения нет', async () => {
    const { fetchImpl: fetch, calls } = createFetchLog(() => responses.plans([month()]));
    render(<Plans api={api(fetch)} sessionLive demo={false} now={NOW} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Изменить' }));
    const input = screen.getByLabelText('Новая цена, ⭐');
    // `input[type=number]` означал бы стрелки и колесо мыши: цена менялась бы
    // случайным движением. Цена печатается.
    expect(input.getAttribute('type')).toBe('text');
    expect(document.querySelectorAll('input[type="number"]')).toHaveLength(0);
    expect(screen.queryByLabelText(/Скидка/)).toBeNull();

    fireEvent.change(input, { target: { value: '349' } });
    fireEvent.change(screen.getByLabelText(/Основание \(обязательно/), { target: { value: 'прайс-лист v3' } });
    fireEvent.change(screen.getByLabelText('Повтори новую цену'), { target: { value: '943' } });
    expect(screen.getByText(/Введённая цена не совпадает с новой/)).toBeInTheDocument();
    // Не совпало — кнопка второго шага не появляется даже как «вооружённая»:
    // `disabled` снимает с неё право на любое нажатие.
    expect(screen.getByRole('button', { name: 'Отправить правку' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: /Подожди ещё|Подтвердить ещё раз/ })).toBeNull();
    expect(patches(calls)).toHaveLength(0);
  });

  it('совпало — PATCH с новой ценой, комментарием и версией строки; ответ показан целиком', async () => {
    const { fetchImpl: fetch, calls } = createFetchLog((_url, init) =>
      (init.method ?? 'GET') === 'PATCH'
        ? responses.json({ plan: month({ price_stars: 349, version: 8 }), effective_from: iso(0), price_change_scope: 'only_new_purchases' })
        : responses.plans([month()]),
    );
    render(<Plans api={api(fetch)} sessionLive demo={false} now={NOW} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Изменить' }));
    fireEvent.change(screen.getByLabelText('Новая цена, ⭐'), { target: { value: '349' } });
    fireEvent.change(screen.getByLabelText(/Основание \(обязательно/), { target: { value: 'прайс-лист v3' } });
    fireEvent.change(screen.getByLabelText('Повтори новую цену'), { target: { value: '349' } });
    pressTwice(/Отправить правку/);

    await waitFor(() => {
      expect(patches(calls)).toHaveLength(1);
    });
    const patch = only(patches(calls), 'PATCH тарифа');
    expect(patch.url).toContain('/api/v1/admin/plans/month_399');
    expect(header(patch, 'X-Admin-CSRF')).toBe('токен');
    const sent = jsonBody(patch);
    // Ровно то, что требует контракт: цена, комментарий, версия. Ничего лишнего
    // (`is_active`, «скидка») панель не присылает — сервер ответил бы 422.
    expect(sent).toEqual({ price_stars: 349, comment: 'прайс-лист v3', base_version: 7 });
    expect(sent).not.toHaveProperty('discount_price_stars');
    expect(sent).not.toHaveProperty('is_active');
    // Формулировку «кого касается» даёт сервер в ответе — и она показана.
    expect(await screen.findByText(/только новые покупки — активные подписки не трогаются/)).toBeInTheDocument();
    expect(screen.getByText(/Тариф обновлён: Месяц · 349 ⭐/)).toBeInTheDocument();
    // Каталог перечитан после правки.
    await waitFor(() => {
      expect(planGets(calls).length).toBeGreaterThanOrEqual(2);
    });
  });

  it('снятие test_only уезжает с confirm; установка — без него', async () => {
    const { fetchImpl: fetch, calls } = createFetchLog((_url, init) =>
      (init.method ?? 'GET') === 'PATCH'
        ? responses.json({ plan: month({ code: 'test_1', test_only: false, active: true }), effective_from: iso(0) })
        : responses.plans([testPlan]),
    );
    render(<Plans api={api(fetch)} sessionLive demo={false} now={NOW} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Изменить' }));
    const checkbox = screen.getByLabelText('Только для теста');
    expect((checkbox as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText(/правило не названо/)).toBeInTheDocument();
    fireEvent.click(checkbox);
    fireEvent.change(screen.getByLabelText(/Основание \(обязательно/), { target: { value: 'в продажу' } });
    expect(screen.getByText(/Снять флаг = выставить тариф в продажу/)).toBeInTheDocument();
    pressTwice(/Отправить правку/);

    await waitFor(() => {
      expect(patches(calls)).toHaveLength(1);
    });
    const sent = jsonBody(only(patches(calls), 'PATCH флага'));
    expect(sent).toEqual({ test_only: false, confirm: 'disable_test_plan', comment: 'в продажу', base_version: 1 });
    // Цена не менялась — её в теле нет: патчится только то, что отличается.
    expect(sent).not.toHaveProperty('price_stars');
  });

  it('409 price_changed: перечитать каталог и закрыть редактор, а не писать поверх', async () => {
    const { fetchImpl: fetch, calls } = createFetchLog((_url, init) => {
      if ((init.method ?? 'GET') === 'PATCH') {
        return responses.problem(409, 'CONFLICT', 'Тариф изменён другой сессией.', {
          reason: 'price_changed',
          current: { price_stars: 359, version: 9 },
        });
      }
      return responses.plans([month()]);
    });
    render(<Plans api={api(fetch)} sessionLive demo={false} now={NOW} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Изменить' }));
    fireEvent.change(screen.getByLabelText('Новая цена, ⭐'), { target: { value: '349' } });
    fireEvent.change(screen.getByLabelText(/Основание \(обязательно/), { target: { value: 'прайс-лист v3' } });
    fireEvent.change(screen.getByLabelText('Повтори новую цену'), { target: { value: '349' } });
    pressTwice(/Отправить правку/);

    expect(await screen.findByText(/Тариф изменили, пока ты набирал цену/)).toBeInTheDocument();
    expect(screen.getByText(/Тариф изменён другой сессией. \(price_changed\)/)).toBeInTheDocument();
    // Редактор закрыт, каталог перечитан — чужая правка не перезаписана.
    expect(screen.queryByLabelText('Новая цена, ⭐')).toBeNull();
    await waitFor(() => {
      expect(planGets(calls).length).toBeGreaterThanOrEqual(2);
    });
  });

  it('422 с field_errors доходит до формы текстом сервера, а не «что-то пошло не так»', async () => {
    const { fetchImpl: fetch } = createFetchLog((url, init) => {
      if (url.includes('/history')) return responses.history([]);
      if ((init.method ?? 'GET') === 'PATCH') {
        return responses.problem(422, 'VALIDATION_FAILED', 'Проверь поля', {
          field_errors: [{ field: 'comment', message: 'Нужно основание' }],
        });
      }
      return responses.plans([month()]);
    });
    render(<Plans api={api(fetch)} sessionLive demo={false} now={NOW} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Изменить' }));
    fireEvent.change(screen.getByLabelText('Новая цена, ⭐'), { target: { value: '349' } });
    fireEvent.change(screen.getByLabelText(/Основание \(обязательно/), { target: { value: 'прайс-лист v3' } });
    fireEvent.change(screen.getByLabelText('Повтори новую цену'), { target: { value: '349' } });
    pressTwice(/Отправить правку/);

    expect(await screen.findByText(/Проверь поля/)).toBeInTheDocument();
    expect(screen.getByText(/unknown_field|comment: Нужно основание/)).toBeInTheDocument();
  });

  it('история цены: «было → стало» и снимок имени из строки истории', async () => {
    const { fetchImpl: fetch } = createFetchLog((url) =>
      url.includes('/history')
        ? responses.history([
            historyEntry(),
            // Первая запись истории: прежней цены не было — это «—», а не 0 ⭐.
            historyEntry({ id: 'ph-1', price_stars: 449, previous_price_stars: null, version: 1, comment: 'создание тарифа', actor_name: 'Поддержка', actor_tg_id: '777002' }),
          ])
        : responses.plans([month()]),
    );
    render(<Plans api={api(fetch)} sessionLive demo={false} now={NOW} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Показать историю' }));
    const table = await screen.findByText('прайс перед новогодним пушем');
    const row = table.closest('tr');
    if (row === null) throw new Error('строка истории не отрисована');
    expect(within(row).getByText('449')).toBeInTheDocument();
    expect(within(row).getByText('Владелец')).toBeInTheDocument();
    const first = screen.getByText('создание тарифа').closest('tr');
    if (first === null) throw new Error('первая строка истории не отрисована');
    expect(within(first).getByText('—')).toBeInTheDocument();
    expect(within(first).queryByText(/^0$/)).toBeNull();
  });

  it('POST /admin/plans — заглушка: экран называет пробел и не дёргает адрес', async () => {
    const { fetchImpl: fetch, calls } = createFetchLog(() => responses.plans([month()]));
    render(<Plans api={api(fetch)} sessionLive demo={false} now={NOW} />);

    await screen.findByText('399');
    expect(screen.getByText('Чего здесь нет и почему')).toBeInTheDocument();
    expect(screen.getByText('POST /api/v1/admin/plans')).toBeInTheDocument();
    expect(calls.some((call) => call.init.method === 'POST')).toBe(false);
  });

  it('нет сессии — каталог не читается и «недоступно» показано текстом о входе', () => {
    const { fetchImpl: fetch, calls } = createFetchLog(() => responses.plans([month()]));
    render(<Plans api={api(fetch)} sessionLive={false} demo={false} now={NOW} />);

    expect(screen.getByText(/Сессии нет. Войди через Telegram./)).toBeInTheDocument();
    expect(calls).toHaveLength(0);
  });
});
