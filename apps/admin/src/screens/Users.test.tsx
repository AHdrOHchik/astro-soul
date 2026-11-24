/*
 * «Пользователи». Проверяем четыре вещи, за которые на этом экране больно:
 *   • поиск уходит ровно одним параметром (два — серверный 422, и панель его
 *     сама не создаёт);
 *   • возврат звёзд не имеет поля «сколько»: тело запроса — `{charge_id,
 *     reason}`, сумму считает сервер, экран её только показывает и просит
 *     повторить;
 *   • бан и разбан — один маршрут с `banned`, и без второго шага он не
 *     выполняется;
 *   • того, чего в ответе нет, на экране нет: `telegram_id` в списке поиска,
 *     статус «заблокировал бота», карта у человека, который её не строил.
 *
 * Режим `demo: false` здесь больше не про «маршрутов нет»: маршруты `/admin/users*`
 * приехали в 1.6.16. Он про другое — экран не дёргает `POST /admin/users/bulk`,
 * которого в контракте нет и который панель держит заглушкой.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAdminApi } from '../api/admin';
import { createHttp } from '../api/http';
import { createFetchLog, header, jsonBody, only, type Call } from '../testing/fetchLog';
import type { AdminUserCard, AdminUserSummary } from '../api/types';
import { Users } from './Users';

const NOW = Date.UTC(2026, 10, 20, 12, 0, 0);
const DAY = 86_400_000;
const USER = '2b1f7a04-9d3c-4e21-8a55-000000000001';
const iso = (offsetMs: number): string => new Date(NOW + offsetMs).toISOString();

const summary = (overrides: Partial<AdminUserSummary> = {}): AdminUserSummary => ({
  user_id: USER,
  alias: 'anna_chart',
  has_subscription: true,
  subscription_plan: 'month',
  subscription_expires_at: iso(21 * DAY),
  banned: false,
  created_at: iso(-120 * DAY),
  last_seen_at: iso(-3 * 3_600_000),
  ...overrides,
});

const card = (overrides: Partial<AdminUserCard> = {}): AdminUserCard => ({
  user_id: USER,
  alias: 'anna_chart',
  created_at: iso(-120 * DAY),
  last_seen_at: iso(-3 * 3_600_000),
  telegram_id: '777003',
  push_enabled: true,
  banned: false,
  subscription: { plan: 'month', is_active: true, expires_at: iso(21 * DAY), auto_renew: false, stars_paid_total: 798 },
  payments: [
    { charge_id: 'chg_9001', plan_code: 'month_399', amount_stars: 399, status: 'paid', is_test: false, paid_at: iso(-9 * DAY) },
  ],
  grants: [],
  counts: { reports: 4, compatibility: 1, questions: 12, forecasts: 2 },
  cost_rub: 18.4,
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

function respondWith(body: unknown, status = 200, contentType = 'application/json'): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': contentType } });
}

const posts = (calls: readonly Call[]): Call[] => calls.filter((call) => call.init.method === 'POST');

/** Маршрут по умолчанию: поиск отдаёт одну строку, карточка — `card()`. */
function router(userCard: AdminUserCard = card()) {
  return createFetchLog((url, init) => {
    if ((init.method ?? 'GET') === 'POST') return respondWith({}, 500);
    if (url.includes('/admin/users?')) return respondWith({ items: [summary()], truncated: false });
    if (url.includes('/admin/users/')) return respondWith(userCard);
    return respondWith({ items: [] });
  });
}

/** Вводит запрос в форму и жмёт «Искать»; radio-режим — если задан. */
function search(mode: 'telegram_id' | 'alias' | 'q', value: string) {
  if (mode !== 'telegram_id') {
    fireEvent.click(screen.getByLabelText(mode === 'alias' ? 'alias' : 'текстом'));
  }
  const input = document.querySelector('fieldset input[type="text"]');
  if (!(input instanceof HTMLInputElement)) throw new Error('поле поиска не отрисовано');
  fireEvent.change(input, { target: { value } });
  fireEvent.click(screen.getByRole('button', { name: 'Искать' }));
}

/** Сколько текстовых полей в блоке возврата — там быть им не должно. */
function refundInputs(): number {
  const lead = screen.getByText(/Сумму считает сервер/);
  const form = lead.parentElement;
  if (form === null) throw new Error('блок возврата не отрисован');
  return form.querySelectorAll('input[type="text"]').length;
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
    const log = router();
    const { fetchImpl: fetch, calls } = log;
    render(<Users api={api(fetch)} sessionLive demo={false} />);

    search('telegram_id', '777003');
    await waitFor(() => {
      expect(screen.getByText('anna_chart')).toBeInTheDocument();
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

  it('в списке поиска нет telegram_id: сервер его в список не кладёт', async () => {
    const { fetchImpl: fetch } = router();
    render(<Users api={api(fetch)} sessionLive demo={false} />);

    search('q', 'anna');
    await waitFor(() => {
      expect(screen.getByText('anna_chart')).toBeInTheDocument();
    });
    // `777003` есть в `AdminUserCard`, но не в `AdminUserSummary` — экран не
    // имеет права показывать то, чего ему не присылали.
    expect(screen.queryByText('777003')).toBeNull();
    expect(screen.getByText(/Telegram ID в списке людей не показывается/)).toBeInTheDocument();
  });

  it('буквы в telegram_id отбиваются до запроса', () => {
    const { fetchImpl: fetch, calls } = router();
    render(<Users api={api(fetch)} sessionLive demo={false} />);

    const input = document.querySelector('fieldset input[type="text"]');
    if (!(input instanceof HTMLInputElement)) throw new Error('поле поиска не отрисовано');
    fireEvent.change(input, { target: { value: '77a03' } });

    expect(screen.getByText('telegram_id — только цифры (до 20 знаков)')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Искать' })).toBeDisabled();
    expect(calls).toHaveLength(0);
  });

  it('пустой результат — «не нашли», а не «ошибка»', async () => {
    const { fetchImpl: fetch } = createFetchLog(() => respondWith({ items: [], truncated: false }));
    render(<Users api={api(fetch)} sessionLive demo={false} />);

    search('q', 'нет такого');
    expect(await screen.findByText('Никого не нашли. Поиск не чинит опечатку сам.')).toBeInTheDocument();
    expect(document.querySelectorAll('.banner--crit')).toHaveLength(0);
  });

  it('маршрута нет — запроса нет: экран называет пробел и не дёргает /users/bulk', async () => {
    // Массовых действий в контракта нет; заглушка обязана быть заглушкой.
    const { fetchImpl: fetch, calls } = createFetchLog((url, init) => {
      if (url.includes('/admin/users?') && (init.method ?? 'GET') === 'GET') return respondWith({ items: [summary()], truncated: false });
      return respondWith({}, 500);
    });
    render(<Users api={api(fetch)} sessionLive demo={false} />);

    search('q', 'anna');
    await screen.findByText('anna_chart');

    expect(screen.getByText('Чего здесь нет и почему')).toBeInTheDocument();
    expect(screen.getByText('POST /api/v1/admin/users/bulk')).toBeInTheDocument();
    expect(calls.some((call) => call.url.includes('/users/bulk'))).toBe(false);
    expect(posts(calls)).toHaveLength(0);
  });

  it('карточка: сумма возврата — серверная, поля её ввода нет, в теле только charge_id и reason', async () => {
    const { fetchImpl: fetch, calls } = createFetchLog((url, init) => {
      if ((init.method ?? 'GET') === 'POST' && url.includes('/refund')) {
        return respondWith({ ok: true, charge_id: 'chg_9001', amount_stars: 399, refunded_at: iso(0), access_revoked: false });
      }
      if (url.includes('/admin/users/')) return respondWith(card());
      return respondWith({ items: [summary()], truncated: false });
    });
    render(<Users api={api(fetch)} sessionLive demo={false} />);

    search('telegram_id', '777003');
    fireEvent.click(await screen.findByRole('button', { name: 'Открыть карточку' }));

    // 399 ⭐ показан дважды: в строке платежа и в строке «сумма к возврату».
    // Это одно и то же серверное число — панель его не пересчитывала.
    const amounts = await screen.findAllByText(/399 ⭐/);
    expect(amounts.length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText(/Сумму считает сервер/)).toBeInTheDocument();
    // «Сколько вернуть» — не поле: ни number-инпута, ни текстового инпута с
    // суммой на экране нет (есть только select платежа, textarea причины и эхо).
    expect(document.querySelectorAll('input[type="number"]')).toHaveLength(0);
    // Сумма — строка текста, а не поле: единственный текстовый input в этой
    // форме — эхо-подтверждение. Ввести «сколько вернуть» нельзя физически.
    expect(screen.queryAllByLabelText(/^Сумма к возврату$/)).toHaveLength(0);
    expect(refundInputs()).toBe(1);

    // Без второго шага запрос не уходит вовсе.
    fireEvent.change(screen.getByLabelText(/Повтори сумму/), { target: { value: '100' } });
    expect(screen.getByText('Введённая сумма не совпадает с серверной.')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/Основание для возврата/), { target: { value: 'обращение 4211' } });
    expect(calls.filter((call) => call.url.includes('/refund'))).toHaveLength(0);

    fireEvent.change(screen.getByLabelText(/Повтори сумму/), { target: { value: '399' } });
    pressTwice(/Вернуть звёзды/);

    await waitFor(() => {
      expect(posts(calls).some((call) => call.url.includes('/refund'))).toBe(true);
    });
    const refund = only(calls.filter((call) => call.url.includes('/refund')), 'POST возврата');
    expect(refund.url).toContain(`/api/v1/admin/users/${USER}/refund`);
    expect(header(refund, 'X-Admin-CSRF')).toBe('токен');
    const sent = jsonBody(refund);
    expect(sent).toEqual({ charge_id: 'chg_9001', reason: 'обращение 4211' });
    expect(sent).not.toHaveProperty('amount_stars');
    expect(sent).not.toHaveProperty('amount');
    expect(sent).not.toHaveProperty('currency');
    // Доступ сервер не отозвал — экран обязан сказать это словами, а не галочкой.
    expect(await screen.findByText(/Звёзды вернутся, доступ останется/)).toBeInTheDocument();
    // Карточка перечитана: возврат — не «тихая галочка».
    await waitFor(() => {
      expect(calls.filter((call) => call.url.includes(`/admin/users/${USER}`) && (call.init.method ?? 'GET') === 'GET').length).toBeGreaterThanOrEqual(2);
    });
  });

  it('возвращать нечего — формы возврата нет, есть текст о состоянии платежей', async () => {
    const { fetchImpl: fetch, calls } = createFetchLog((url, init) => {
      if ((init.method ?? 'GET') === 'POST') return respondWith({}, 500);
      if (url.includes('/admin/users/')) {
        return respondWith(
          card({
            payments: [
              { charge_id: 'chg_8100', plan_code: 'month_399', amount_stars: 399, status: 'refunded', is_test: false, paid_at: iso(-39 * DAY), refunded_at: iso(-38 * DAY) },
              { charge_id: 'chg_7001', plan_code: 'test_1', amount_stars: 1, status: 'failed', is_test: true, paid_at: iso(-40 * DAY) },
            ],
          }),
        );
      }
      return respondWith({ items: [summary()], truncated: false });
    });
    render(<Users api={api(fetch)} sessionLive demo={false} />);

    search('telegram_id', '777003');
    fireEvent.click(await screen.findByRole('button', { name: 'Открыть карточку' }));

    expect(await screen.findByText('Возвращать нечего: нет оплаченного платежа без возврата.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Вернуть звёзды' })).toBeNull();
    expect(posts(calls)).toHaveLength(0);
  });

  it('бан без основания не отправляется; с основанием — один POST с banned: true', async () => {
    const { fetchImpl: fetch, calls } = createFetchLog((url, init) => {
      if ((init.method ?? 'GET') === 'POST') return respondWith({ user_id: USER, banned: true, banned_at: iso(0), reason: 'спам' });
      if (url.includes('/admin/users/')) return respondWith(card());
      return respondWith({ items: [summary()], truncated: false });
    });
    render(<Users api={api(fetch)} sessionLive demo={false} />);

    search('telegram_id', '777003');
    fireEvent.click(await screen.findByRole('button', { name: 'Открыть карточку' }));

    const banButton = await screen.findByRole('button', { name: 'Заблокировать' });
    expect(banButton).toBeDisabled();
    expect(posts(calls)).toHaveLength(0);

    fireEvent.change(screen.getByLabelText(/Основание \(обязательно, уйдёт в аудит\)/), { target: { value: 'спам' } });
    // Первый клик — только «вооружение»: запроса нет ни сразу, ни раньше паузы.
    fireEvent.click(screen.getByRole('button', { name: 'Заблокировать' }));
    expect(posts(calls)).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: /Подожди ещё/ }));
    expect(posts(calls)).toHaveLength(0);
    // Основание повторено в тексте подтверждения — его видно до отправки.
    expect(screen.getByText(/Заблокировать · anna_chart — спам/)).toBeInTheDocument();
    vi.mocked(Date.now).mockReturnValue(NOW + 2_100);
    fireEvent.click(screen.getByRole('button', { name: /Подожди ещё|Подтвердить ещё раз/ }));

    await waitFor(() => {
      expect(posts(calls).some((call) => call.url.includes('/ban'))).toBe(true);
    });
    const ban = only(calls.filter((call) => call.url.includes('/ban')), 'POST блокировки');
    expect(ban.url).toContain(`/api/v1/admin/users/${USER}/ban`);
    expect(jsonBody(ban)).toEqual({ banned: true, reason: 'спам' });
    expect(header(ban, 'X-Admin-CSRF')).toBe('токен');
    // Отдельного `/unban` нет — и запрос на него появиться не может.
    expect(calls.some((call) => call.url.includes('/unban'))).toBe(false);
  });

  it('разбан — тот же маршрут с banned: false', async () => {
    const { fetchImpl: fetch, calls } = createFetchLog((url, init) => {
      if ((init.method ?? 'GET') === 'POST') return respondWith({ user_id: USER, banned: false, banned_at: null, reason: null });
      if (url.includes('/admin/users/')) return respondWith(card({ banned: true, banned_at: iso(-10 * DAY), ban_reason: 'спам' }));
      return respondWith({ items: [summary({ banned: true })], truncated: false });
    });
    render(<Users api={api(fetch)} sessionLive demo={false} />);

    search('telegram_id', '777003');
    fireEvent.click(await screen.findByRole('button', { name: 'Открыть карточку' }));

    // Заблокированный человек виден по `banned`, а не по «есть дата бана».
    expect(await screen.findByText(/Заблокирован/)).toBeInTheDocument();
    const button = await screen.findByRole('button', { name: 'Разблокировать' });
    expect(button).toBeDisabled();

    fireEvent.change(screen.getByLabelText(/Основание \(обязательно, уйдёт в аудит\)/), { target: { value: 'обращение 4290 — разбан' } });
    pressTwice(/Разблокировать/);

    await waitFor(() => {
      expect(posts(calls).some((call) => call.url.includes('/ban'))).toBe(true);
    });
    const ban = only(calls.filter((call) => call.url.includes('/ban')), 'POST разбана');
    expect(jsonBody(ban)).toEqual({ banned: false, reason: 'обращение 4290 — разбан' });
    expect(await screen.findByText(/Состояние обновлено · Разблокирован/)).toBeInTheDocument();
  });

  it('пуш: запрос без тела, ответ показан; 409 push_disabled переведён в «заблокировал бота»', async () => {
    const { fetchImpl: fetch, calls } = createFetchLog((url, init) => {
      if ((init.method ?? 'GET') === 'POST' && url.includes('/push')) {
        return respondWith(
          { code: 'CONFLICT', message: 'У человека выключены пуши.', request_id: 'r-11', details: { reason: 'push_disabled' } },
          409,
          'application/problem+json',
        );
      }
      if (url.includes('/admin/users/')) return respondWith(card());
      return respondWith({ items: [summary()], truncated: false });
    });
    render(<Users api={api(fetch)} sessionLive demo={false} />);

    search('telegram_id', '777003');
    fireEvent.click(await screen.findByRole('button', { name: 'Открыть карточку' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Отправить проверочный пуш' }));

    await waitFor(() => {
      expect(posts(calls)).toHaveLength(1);
    });
    const push = only(posts(calls), 'POST пуша');
    expect(push.url).toContain(`/api/v1/admin/users/${USER}/push`);
    expect(header(push, 'X-Admin-CSRF')).toBe('токен');
    // Тела у запроса нет вовсе: `push_enabled` — не переключатель панели, а
    // выбор человека в мини-аппе. Мок-ответ с `{}` выглядел бы тем же самым.
    expect(push.init.body === undefined || push.init.body === '').toBe(true);
    expect(await screen.findByText(/У человека выключены пуши. \(push_disabled\)/)).toBeInTheDocument();
    expect(screen.getByText(/Человек заблокировал бота, пуши выключены/)).toBeInTheDocument();
    // Поля `telegram_status` в контракте нет — экран обязан сказать это, а не
    // выдумывать статус доставки.
    expect(screen.getByText(/Поля `telegram_status` в контракте нет/)).toBeInTheDocument();
  });

  it('успешный пуш показывает sent_at и kind из ответа сервера', async () => {
    const { fetchImpl: fetch } = createFetchLog((url, init) => {
      if ((init.method ?? 'GET') === 'POST') return respondWith({ user_id: USER, sent: true, sent_at: iso(0), kind: 'test' });
      if (url.includes('/admin/users/')) return respondWith(card());
      return respondWith({ items: [summary()], truncated: false });
    });
    render(<Users api={api(fetch)} sessionLive demo={false} />);

    search('telegram_id', '777003');
    fireEvent.click(await screen.findByRole('button', { name: 'Открыть карточку' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Отправить проверочный пуш' }));

    expect(await screen.findByText(/Пуш ушёл · .*test/)).toBeInTheDocument();
  });

  it('409 на возврат — текст сервера на экране, а не «готово»', async () => {
    const { fetchImpl: fetch } = createFetchLog((url, init) => {
      if ((init.method ?? 'GET') === 'POST' && url.includes('/refund')) {
        return respondWith(
          { code: 'CONFLICT', message: 'По этому платежу уже был возврат.', request_id: 'r-9', details: { reason: 'already_refunded' } },
          409,
          'application/problem+json',
        );
      }
      if (url.includes('/admin/users/')) return respondWith(card());
      return respondWith({ items: [summary()], truncated: false });
    });
    render(<Users api={api(fetch)} sessionLive demo={false} />);

    search('telegram_id', '777003');
    fireEvent.click(await screen.findByRole('button', { name: 'Открыть карточку' }));
    await screen.findByText(/Сумму считает сервер/);
    fireEvent.change(screen.getByLabelText(/Основание для возврата/), { target: { value: 'дубль обращения' } });
    fireEvent.change(screen.getByLabelText(/Повтори сумму/), { target: { value: '399' } });
    pressTwice(/Вернуть звёзды/);

    expect(await screen.findByText(/По этому платежу уже был возврат. \(already_refunded\)/)).toBeInTheDocument();
    expect(screen.queryByText(/Возврат проведён/)).toBeNull();
  });

  it('сервер сказал 422 с field_errors — поле получило свою строку, а не «что-то пошло не так»', async () => {
    const { fetchImpl: fetch } = createFetchLog((url, init) => {
      if ((init.method ?? 'GET') === 'POST' && url.includes('/ban')) {
        return respondWith(
          {
            code: 'VALIDATION_FAILED',
            message: 'Проверь поля',
            request_id: 'r-12',
            details: { field_errors: [{ field: 'reason', message: 'Слишком короткое основание' }] },
          },
          422,
          'application/problem+json',
        );
      }
      if (url.includes('/admin/users/')) return respondWith(card());
      return respondWith({ items: [summary()], truncated: false });
    });
    render(<Users api={api(fetch)} sessionLive demo={false} />);

    search('telegram_id', '777003');
    fireEvent.click(await screen.findByRole('button', { name: 'Открыть карточку' }));
    await screen.findByRole('button', { name: 'Заблокировать' });
    fireEvent.change(screen.getByLabelText(/Основание \(обязательно, уйдёт в аудит\)/), { target: { value: 'спам' } });
    pressTwice(/Заблокировать/);

    expect(await screen.findByText(/Проверь поля/)).toBeInTheDocument();
    expect(screen.getByText(/reason: Слишком короткое основание/)).toBeInTheDocument();
  });

  it('«данных нет» ≠ «ошибка»: карты и профиля нет — экран это говорит спокойно', async () => {
    const { fetchImpl: fetch } = createFetchLog((url, init) => {
      if ((init.method ?? 'GET') === 'POST') return respondWith({}, 500);
      if (url.includes('/admin/users/')) {
        return respondWith(
          card({
            profile: undefined,
            chart: undefined,
            subscription: null,
            last_seen_at: null,
            telegram_id: null,
            payments: [],
          }),
        );
      }
      return respondWith({ items: [summary()], truncated: false });
    });
    render(<Users api={api(fetch)} sessionLive demo={false} />);

    search('telegram_id', '777003');
    fireEvent.click(await screen.findByRole('button', { name: 'Открыть карточку' }));

    expect(await screen.findByText('Карты нет: человек её ещё не строил.')).toBeInTheDocument();
    expect(screen.getByText('Активной подписки нет.')).toBeInTheDocument();
    expect(screen.getByText(/Сервер не вернул/)).toBeInTheDocument();
    // «не заходил» показан прочерком, а не нулём и не датой 1970 года.
    expect(screen.queryByText(/1970/)).toBeNull();
    expect(document.querySelectorAll('.banner--crit')).toHaveLength(0);
  });
});
