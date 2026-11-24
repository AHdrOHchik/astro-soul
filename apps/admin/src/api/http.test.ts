/*
 * Транспорт: здесь проверяются именно те обещания, которые панель даёт
 * безопасностью — CSRF, отсутствие «сам себе придумал», отсутствие повторов у
 * неизменяющих запросов и то, что 401 гасит сессию, а не показывает пустые
 * таблицы.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CSRF_HEADER, createHttp } from './http';
import { createAdminApi } from './admin';
import { ADMIN_ROUTES } from './routes';
import type { ProbeResult } from './http';
import { createFetchLog, header, jsonResponse, only } from '../testing/fetchLog';

const recorder = (response: () => Response) => createFetchLog(() => response());

describe('http-слой админки', () => {
  beforeEach(() => {
    expect(ADMIN_ROUTES.length).toBeGreaterThan(0);
  });

  it('не отправляет POST без CSRF-токена и не уходит в сеть', async () => {
    const { calls, fetchImpl } = recorder(() => jsonResponse({}));
    const http = createHttp({ fetchImpl, csrfToken: () => null });

    await expect(http.call('codesCreate', { body: { kind: 'single_report', max_activations: 1 } })).rejects.toMatchObject({
      code: 'CSRF_MISSING',
    });
    expect(calls).toHaveLength(0);
  });

  it('кладёт токен в заголовок на каждом изменяющем запросе', async () => {
    const { calls, fetchImpl } = recorder(() => jsonResponse({ id: 'x' }));
    const http = createHttp({ fetchImpl, csrfToken: () => 'токен' });

    await http.call('codesCreate', { body: { kind: 'single_report', max_activations: 1 } });
    const created = only(calls, 'POST создания кода');
    expect(header(created, CSRF_HEADER)).toBe('токен');
    expect(created.init.method).toBe('POST');
  });

  it('живёт на своём origin: same-origin credentials, никаких абсолютных адресов', async () => {
    const { calls, fetchImpl } = recorder(() => jsonResponse({ items: [] }));
    const http = createHttp({ fetchImpl });

    await http.call('codesList');
    const listed = only(calls, 'запрос списка кодов');
    expect(listed.url).toBe('/api/v1/admin/codes');
    expect(listed.init.credentials).toBe('same-origin');
  });

  it('собирает query и отбрасывает пустые значения', async () => {
    const { calls, fetchImpl } = recorder(() => jsonResponse({ items: [] }));
    const http = createHttp({ fetchImpl });

    await http.call('grantsList', { query: { user_id: ' u-1 ', empty: undefined, blank: '', zero: 0, off: false } });
    expect(only(calls, 'запрос грантов').url).toBe('/api/v1/admin/grants?user_id=u-1&zero=0&off=false');
  });

  it('не повторяет POST: повторённый непроверяемый запрос создал бы лишний код', async () => {
    const { calls, fetchImpl } = recorder(() => jsonResponse({}, { status: 500 }));
    const http = createHttp({ fetchImpl, retries: 2, retryDelayMs: () => 0, csrfToken: () => 'токен' });

    await expect(http.call('codesCreate', { body: {} })).rejects.toMatchObject({ status: 500 });
    expect(calls).toHaveLength(1);
  });

  it('повторяет GET на 5xx ровно `retries` раз', async () => {
    const { calls, fetchImpl } = recorder(() => jsonResponse({}, { status: 503 }));
    const http = createHttp({ fetchImpl, retries: 2, retryDelayMs: () => 0 });

    await expect(http.call('codesList')).rejects.toMatchObject({ status: 503 });
    expect(calls).toHaveLength(3);
  });

  it('401 гасит сессию, а не оставляется «живой панелью»', async () => {
    const onUnauthorized = vi.fn();
    const { fetchImpl } = recorder(() =>
      jsonResponse({ code: 'UNAUTHORIZED', message: 'Нет initData', request_id: 'r1' }, { status: 401 }),
    );
    const http = createHttp({ fetchImpl, onUnauthorized });

    await expect(http.call('metrics')).rejects.toMatchObject({ status: 401, code: 'UNAUTHORIZED' });
    expect(onUnauthorized).toHaveBeenCalledOnce();
  });

  it('`treatAsOk: [503]` живёт только у /health: 503 от /admin/metrics — ошибка, а не пустые метрики', async () => {
    const { fetchImpl, calls } = recorder(() =>
      jsonResponse({ code: 'INTERNAL', message: 'метрики нечитаемы', request_id: 'req-503' }, { status: 503 }),
    );
    const api = createAdminApi(createHttp({ fetchImpl, retries: 0, retryDelayMs: () => 0 }));

    await expect(api.metrics()).rejects.toMatchObject({ status: 503, code: 'INTERNAL' });
    // Ровно один запрос: `retries: 0` в тесте, и никаких «прочитали Problem как метрики».
    expect(calls.length).toBe(1);
  });

  it('а /health через AdminApi отвечает телом и на 503: статус «degraded» видно, исключения нет', async () => {
    const { fetchImpl } = recorder(() =>
      jsonResponse({ status: 'degraded', db: 'down', flags: { bonus_budget: { exhausted: true } } }, { status: 503 }),
    );
    const api = createAdminApi(createHttp({ fetchImpl, retries: 0, retryDelayMs: () => 0 }));

    const result = await api.health();
    expect(result.status).toBe(503);
    expect(result.data).toMatchObject({ status: 'degraded', db: 'down' });
  });

  it('пустой ответ алертов — это список нулевой длины, а не ошибка', async () => {
    const { fetchImpl } = recorder(() => jsonResponse({ alerts: [], checked_at: null }));
    const api = createAdminApi(createHttp({ fetchImpl }));

    await expect(api.alerts()).resolves.toMatchObject({ data: { alerts: [] } });
  });

  it('читает тело /health и на 503: мониторинг обязан понять, что именно упало', async () => {
    const { fetchImpl } = recorder(() =>
      jsonResponse({ status: 'degraded', db: 'down', flags: { test_plans: false } }, { status: 503 }),
    );
    const http = createHttp({ fetchImpl });

    const result = await http.call<{ status?: string; db?: string }>('health', { treatAsOk: [503] });
    expect(result.status).toBe(503);
    expect(result.data).toMatchObject({ status: 'degraded', db: 'down' });
  });

  it('сообщает, что данные пришли от мокера, и только по заголовку', async () => {
    const { fetchImpl } = recorder(() => jsonResponse({ items: [] }, { headers: { 'X-Admin-Demo': '1' } }));
    const http = createHttp({ fetchImpl });

    const demo = await http.call('codesList');
    expect(demo.demo).toBe(true);

    const { fetchImpl: plain } = recorder(() => jsonResponse({ items: [] }));
    const real = await createHttp({ fetchImpl: plain }).call('codesList');
    expect(real.demo).toBe(false);
  });

  it('не ходит в сеть на маршруты, которых нет в контракте', async () => {
    const { calls, fetchImpl } = recorder(() => jsonResponse({}));
    const http = createHttp({ fetchImpl });

    // «Пользователей» и «Тарифов» этот гейт касался до 1.6.16; теперь он
    // проверяется на маршруте, которого в контракте нет по-настоящему.
    await expect(http.call('usersBulk')).rejects.toMatchObject({ code: 'ROUTE_NOT_IN_CONTRACT' });
    await expect(http.call('paymentDetail')).rejects.toMatchObject({ code: 'ROUTE_NOT_IN_CONTRACT' });
    expect(calls).toHaveLength(0);
  });

  it('dev-мокер — единственное исключение, и 404 там трактуется как «маршрута нет»', async () => {
    const { calls, fetchImpl } = recorder(() => jsonResponse({ code: 'NOT_FOUND', message: 'Такой страницы нет.', request_id: 'r' }, { status: 404 }));
    const http = createHttp({ fetchImpl, allowUnknownRoutes: true });

    const probed: ProbeResult<unknown> = await http.probe('paymentDetail', { params: { id: 'chg_9001' } });
    expect(probed.kind).toBe('unavailable');
    expect(calls).toHaveLength(1);
  });

  it('404 на маршруте из контракта — ответ сервера, а не «маршрута нет»', async () => {
    // Иначе «не туда отправил» и «сервер не нашёл» выглядели бы одинаково, а
    // для входа это ровно та подмена, из-за которой человек ищет баг не там.
    const { fetchImpl } = recorder(() => jsonResponse({ code: 'NOT_FOUND', message: 'Маршрут не найден.', request_id: 'r' }, { status: 404 }));
    const http = createHttp({ fetchImpl, retries: 0 });

    await expect(http.call('authMe')).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
  });

  it('probe различает «нет маршрута», «не вошёл» и аварию', async () => {
    const unavailable = await createHttp({ fetchImpl: recorder(() => jsonResponse({})).fetchImpl }).probe('usersBulk');
    expect(unavailable.kind).toBe('unavailable');

    const unauthorized = await createHttp({ fetchImpl: recorder(() => jsonResponse({}, { status: 401 })).fetchImpl }).probe('authMe');
    expect(unauthorized.kind).toBe('unauthorized');

    const error = await createHttp({ fetchImpl: recorder(() => jsonResponse({}, { status: 500 })).fetchImpl, retries: 0 }).probe('metrics');
    expect(error.kind).toBe('error');
  });

  it('422 с field_errors доездает до экрана как есть', async () => {
    const { fetchImpl } = recorder(() =>
      jsonResponse(
        {
          code: 'VALIDATION_FAILED',
          message: 'Проверь поля',
          request_id: 'r2',
          details: { field_errors: [{ field: 'user_id', message: 'Укажи user_id' }] },
        },
        { status: 422 },
      ),
    );
    const http = createHttp({ fetchImpl });

    const error = await http.call('grantsList', { query: {} }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as { fieldErrors: readonly { field: string }[] }).fieldErrors[0]?.field).toBe('user_id');
    expect((error as { message: string }).message).toBe('Проверь поля');
  });

  it('параметры пути подставляются в шаблон и экранируются; незаполненный шаблон — ошибка вызова', async () => {
    // Карточка человека живёт на `/admin/users/{id}` (маршрут вне контракта —
    // идём ДЕМО-веткой `allowUnknownRoutes`). `77/x` в id обязан остаться
    // частью пути, а не «выйти» из него; а вызов без параметра — упасть до
    // сети: 404 на литеральный `{id}` выглядел бы как «нет человека», и это
    // была бы ложь.
    const log = createFetchLog(() => jsonResponse({ user_id: 'x' }));
    const demo = createHttp({ fetchImpl: log.fetchImpl, retries: 0, allowUnknownRoutes: true });

    await demo.call('userCard', { params: { id: '77/x' } });
    expect(log.calls[0]?.url).toBe('/api/v1/admin/users/77%2Fx');

    await expect(demo.call('userCard', {})).rejects.toThrow(/без параметра пути/);
    expect(log.calls).toHaveLength(1);
  });

});
