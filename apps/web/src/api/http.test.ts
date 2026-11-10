import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, isAbortError } from './errors';
import { createHttpClient, DEFAULT_TIMEOUT_MS, INIT_DATA_HEADER, type HttpClientOptions } from './http';

const json = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), { status });

/** A request that never answers but honours cancellation, like a stalled connection. */
const stalled: typeof fetch = (_input, init) =>
  new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => {
      reject(new DOMException('Aborted', 'AbortError'));
    });
  });

function setup(overrides: Partial<HttpClientOptions> = {}) {
  const fetchMock = vi.fn<typeof fetch>();
  const request = createHttpClient({
    baseUrl: 'https://api.test',
    getInitData: () => 'query_id=1&hash=abc',
    fetch: fetchMock,
    ...overrides,
  });
  return { fetchMock, request };
}

/** Settles a promise into its error so assertions can run after fake timers advance. */
const errorOf = (promise: Promise<unknown>) =>
  promise.then(
    () => {
      throw new Error('expected the request to fail');
    },
    (error: unknown) => error,
  );

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('request', () => {
  it('sends initData in X-Telegram-Init-Data and the body as JSON', async () => {
    const { fetchMock, request } = setup();
    fetchMock.mockResolvedValue(json(200, { ok: true }));

    await expect(request('POST', '/api/v1/charts', { body: { a: 1 } })).resolves.toEqual({ ok: true });

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('https://api.test/api/v1/charts');
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe('{"a":1}');
    expect(init?.headers).toMatchObject({ [INIT_DATA_HEADER]: 'query_id=1&hash=abc', 'Content-Type': 'application/json' });
  });

  it('reads initData again for every request instead of caching it', async () => {
    let initData = 'first';
    const { fetchMock, request } = setup({ getInitData: () => initData });
    fetchMock.mockImplementation(() => Promise.resolve(json(200, {})));

    await request('GET', '/a');
    initData = 'second';
    await request('GET', '/b');

    expect(fetchMock.mock.calls.map(([, init]) => (init?.headers as Record<string, string>)[INIT_DATA_HEADER])).toEqual([
      'first',
      'second',
    ]);
  });

  it('sends no auth header outside Telegram rather than an empty one', async () => {
    const { fetchMock, request } = setup({ getInitData: () => '' });
    fetchMock.mockResolvedValue(json(200, {}));
    await request('GET', '/a');
    expect(fetchMock.mock.calls[0]?.[1]?.headers).not.toHaveProperty(INIT_DATA_HEADER);
  });

  it('resolves 204 to undefined', async () => {
    const { fetchMock, request } = setup();
    fetchMock.mockResolvedValue(json(204));
    await expect(request('DELETE', '/api/v1/me')).resolves.toBeUndefined();
  });

  it('asks the browser to finish the call without the page only when the caller says so', async () => {
    const { fetchMock, request } = setup();
    fetchMock.mockImplementation(() => Promise.resolve(json(200, {})));

    await request('POST', '/a', { body: {} });
    await request('POST', '/b', { body: {}, keepalive: true });
    await request('POST', '/c', { body: {}, keepalive: false });

    const [ordinary, last, declined] = fetchMock.mock.calls.map(([, init]) => init);
    // Not `keepalive: false` either: an ordinary call is left exactly as it was before the option existed.
    expect(ordinary).not.toHaveProperty('keepalive');
    expect(last).toHaveProperty('keepalive', true);
    expect(declined).not.toHaveProperty('keepalive');
  });

  it('fails with INVALID_RESPONSE when a 2xx body is not JSON', async () => {
    const { fetchMock, request } = setup();
    fetchMock.mockResolvedValue(new Response('<html>', { status: 200 }));
    await expect(request('GET', '/a')).rejects.toMatchObject({ code: 'INVALID_RESPONSE', status: 200 });
  });
});

describe('errors', () => {
  it('maps a Problem body by its code and keeps the server message and request id', async () => {
    const { fetchMock, request } = setup();
    fetchMock.mockResolvedValue(
      json(429, { code: 'QUOTA_EXCEEDED', message: 'Лимит исчерпан', request_id: 'req-1', details: { limit: 5 } }),
    );

    const error = await errorOf(request('POST', '/api/v1/engagement/ask', { body: {} }));

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      code: 'QUOTA_EXCEEDED',
      status: 429,
      serverMessage: 'Лимит исчерпан',
      requestId: 'req-1',
      details: { limit: 5 },
    });
  });

  it.each([
    [401, 'UNAUTHORIZED'],
    [402, 'PAYMENT_REQUIRED'],
    [403, 'FORBIDDEN'],
    [404, 'NOT_FOUND'],
    [409, 'CONFLICT'],
    [422, 'VALIDATION_FAILED'],
    [429, 'RATE_LIMITED'],
    // The API never answers 400, so a bare one is not a verdict on what the user entered.
    [400, 'INTERNAL'],
    [418, 'INTERNAL'],
  ])('falls back to the status when %i has no Problem body', async (status, code) => {
    const { fetchMock, request } = setup();
    fetchMock.mockResolvedValue(new Response('nope', { status }));
    await expect(request('GET', '/a')).rejects.toMatchObject({ code, status, serverMessage: undefined });
  });

  it('does not trust a code the contract does not know', async () => {
    const { fetchMock, request } = setup();
    fetchMock.mockResolvedValue(json(403, { code: 'toString', message: 'Нельзя', request_id: 'r' }));
    await expect(request('GET', '/a')).rejects.toMatchObject({ code: 'FORBIDDEN', serverMessage: 'Нельзя' });
  });
});

describe('retry', () => {
  it('retries 5xx with backoff and succeeds', async () => {
    const { fetchMock, request } = setup({ retryDelayMs: () => 1000 });
    fetchMock
      .mockResolvedValueOnce(json(500))
      .mockResolvedValueOnce(json(503))
      .mockResolvedValueOnce(json(200, { ok: true }));

    const result = request('GET', '/a');
    await vi.advanceTimersByTimeAsync(999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1000);

    await expect(result).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('gives up after the configured attempts and reports the last answer', async () => {
    const { fetchMock, request } = setup({ retries: 2, retryDelayMs: () => 10 });
    fetchMock.mockImplementation(() =>
      Promise.resolve(json(502, { code: 'UPSTREAM_LLM', message: 'Модель недоступна', request_id: 'r' })),
    );

    const error = errorOf(request('GET', '/a'));
    await vi.advanceTimersByTimeAsync(20);

    expect(await error).toMatchObject({ code: 'UPSTREAM_LLM', status: 502 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it.each([400, 401, 404, 422, 429])('does not retry %i', async (status) => {
    const { fetchMock, request } = setup();
    fetchMock.mockImplementation(() => Promise.resolve(json(status)));
    await expect(request('GET', '/a')).rejects.toBeInstanceOf(ApiError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not retry a network failure', async () => {
    const { fetchMock, request } = setup();
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(request('GET', '/a')).rejects.toMatchObject({ code: 'NETWORK', status: undefined });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not retry 5xx when the call opts out', async () => {
    const { fetchMock, request } = setup();
    fetchMock.mockImplementation(() => Promise.resolve(json(500)));
    await expect(request('POST', '/a', { retry: false })).rejects.toMatchObject({ code: 'INTERNAL' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('timeout', () => {
  it('fails with TIMEOUT after 15 seconds and not earlier', async () => {
    expect(DEFAULT_TIMEOUT_MS).toBe(15_000);
    const { request } = setup({ fetch: stalled });
    const settled = vi.fn();
    const error = errorOf(request('GET', '/a')).then((value) => {
      settled();
      return value;
    });

    await vi.advanceTimersByTimeAsync(14_999);
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(await error).toMatchObject({ code: 'TIMEOUT' });
  });

  it('counts retries against the same 15 seconds', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(json(500)).mockImplementation(stalled);
    const { request } = setup({ fetch: fetchMock, retryDelayMs: () => 5000 });

    const error = errorOf(request('GET', '/a'));
    await vi.advanceTimersByTimeAsync(15_000);

    expect(await error).toMatchObject({ code: 'TIMEOUT' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('times out while waiting between retries', async () => {
    const { fetchMock, request } = setup({ retryDelayMs: () => 60_000 });
    fetchMock.mockImplementation(() => Promise.resolve(json(500)));

    const error = errorOf(request('GET', '/a'));
    await vi.advanceTimersByTimeAsync(15_000);

    expect(await error).toMatchObject({ code: 'TIMEOUT' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('cancellation', () => {
  it('rejects with the AbortError when the caller cancels, not with an ApiError', async () => {
    const { request } = setup({ fetch: stalled });
    const controller = new AbortController();

    const error = errorOf(request('GET', '/a', { signal: controller.signal }));
    controller.abort();

    const caught = await error;
    expect(caught).not.toBeInstanceOf(ApiError);
    expect(isAbortError(caught)).toBe(true);
  });

  it('does not start work for an already cancelled signal', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(stalled);
    const { request } = setup({ fetch: fetchMock });
    const controller = new AbortController();
    controller.abort();

    expect(isAbortError(await errorOf(request('GET', '/a', { signal: controller.signal })))).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
