import { describe, expect, it, vi } from 'vitest';
import { absoluteApiUrl, createApi, fieldErrorsOf, type ChartCreateRequest, type ClientEvent, type GeoPlace } from './index';

const moscow: GeoPlace = { name: 'Москва', region: null, country: 'RU', lat: 55.7558, lon: 37.6173, tz: 'Europe/Moscow' };

const json = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), { status });

function setup({ retries = 0 }: { retries?: number } = {}) {
  const fetchMock = vi.fn<typeof fetch>();
  const api = createApi({ baseUrl: '', getInitData: () => 'init', fetch: fetchMock, retries, retryDelayMs: () => 0 });
  return { api, fetchMock };
}

describe('resolveGeo', () => {
  it('posts the query to the contract path and returns the places', async () => {
    const { api, fetchMock } = setup();
    fetchMock.mockResolvedValue(json(200, [moscow]));

    await expect(api.resolveGeo('Моск')).resolves.toEqual([moscow]);

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('/api/v1/geo/resolve');
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe(JSON.stringify({ query: 'Моск' }));
  });

  it('returns an empty list when no place matches: that is an answer, not a failure', async () => {
    const { api, fetchMock } = setup();
    fetchMock.mockResolvedValue(json(200, []));
    await expect(api.resolveGeo('Ыыы')).resolves.toEqual([]);
  });

  it('reports an unavailable geodata provider as a failure, not as "nothing found"', async () => {
    const { api, fetchMock } = setup();
    const message = 'Поиск городов временно недоступен. Попробуй ещё раз через минуту.';
    fetchMock.mockResolvedValue(json(503, { code: 'GEO_NOT_FOUND', message, request_id: 'r', details: { reason: 'provider_timeout' } }));
    await expect(api.resolveGeo('Моск')).rejects.toMatchObject({
      code: 'GEO_NOT_FOUND',
      status: 503,
      serverMessage: message,
      details: { reason: 'provider_timeout' },
    });
  });

  it.each([
    // What the API answers for a route it does not have.
    ['a NOT_FOUND problem', json(404, { code: 'NOT_FOUND', message: 'Такой страницы нет. Обнови приложение.', request_id: 'r' })],
    ['a bare 404', json(404)],
  ])('does not pass %s off as "nothing found": the route is missing, not the place', async (_name, response) => {
    const { api, fetchMock } = setup();
    fetchMock.mockResolvedValue(response);
    await expect(api.resolveGeo('Моск')).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
  });

  it('keeps real failures as errors', async () => {
    const { api, fetchMock } = setup();
    fetchMock.mockResolvedValue(json(429));
    await expect(api.resolveGeo('Моск')).rejects.toMatchObject({ code: 'RATE_LIMITED' });
  });

  it('rejects places that miss fields the chart request needs', async () => {
    const { api, fetchMock } = setup();
    fetchMock.mockResolvedValue(json(200, [{ name: 'Москва', country: 'RU' }]));
    await expect(api.resolveGeo('Моск')).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });
});

describe('createChart', () => {
  const input: ChartCreateRequest = {
    birth_date: '1994-05-17',
    birth_time: null,
    time_precision: 'unknown',
    birth_place: moscow,
    consent: { accepted: true, version: '2026-11-10' },
  };

  it('sends the request unchanged: a null time with its precision, the full place and the consent', async () => {
    const { api, fetchMock } = setup();
    fetchMock.mockResolvedValue(json(201, { chart: { chart_id: 'c-1', planets: [] } }));

    await expect(api.createChart(input)).resolves.toMatchObject({ chart: { chart_id: 'c-1' } });

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('/api/v1/charts');
    expect(JSON.parse(init?.body as string)).toEqual(input);
  });

  it('returns the reading and both wheel paths as they came', async () => {
    const { api, fetchMock } = setup();
    const reading = { sun: 'Солнце в Телец, 26°17′', moon: 'Луна в Лев, 12°38′', asc: 'Асцендент в Дева, 15°03′', summary: 'Вместе' };
    const wheel = '/api/v1/charts/c-1/wheel.svg?sig=1767225600.abc123';
    const wheelPng = '/api/v1/charts/c-1/wheel.png?sig=1767225600.abc123';
    fetchMock.mockResolvedValue(json(201, { chart: { chart_id: 'c-1' }, mini_reading: reading, wheel_url: wheel, wheel_png_url: wheelPng }));

    await expect(api.createChart(input)).resolves.toMatchObject({ mini_reading: reading, wheel_url: wheel, wheel_png_url: wheelPng });
  });

  it.each([
    ['is not sent, as by a server older than contract 1.3.0', {}],
    ['is empty', { wheel_png_url: '' }],
    ['is not a string', { wheel_png_url: { href: '/wheel.png' } }],
  ])('leaves the PNG path out when it %s: the screen then knows there is none', async (_name, rest) => {
    const { api, fetchMock } = setup();
    fetchMock.mockResolvedValue(json(201, { chart: { chart_id: 'c-1' }, wheel_url: '/api/v1/charts/c-1/wheel.svg?sig=s', ...rest }));

    const result = await api.createChart(input);

    expect(result).not.toHaveProperty('wheel_png_url');
    expect(result.wheel_url).toBe('/api/v1/charts/c-1/wheel.svg?sig=s');
  });

  it.each([
    ['are missing', {}],
    ['are malformed', { mini_reading: ['Солнце'], wheel_url: 42 }],
    ['are partly there', { mini_reading: { sun: null, moon: 7 } }],
  ])('gives the screen empty lines and no wheel when the reading and the wheel path %s', async (_name, rest) => {
    const { api, fetchMock } = setup();
    fetchMock.mockResolvedValue(json(201, { chart: { chart_id: 'c-1' }, ...rest }));

    const result = await api.createChart(input);

    expect(result.mini_reading).toEqual({ sun: '', moon: '', asc: '', summary: '' });
    expect(result.wheel_url).toBe('');
  });

  it('keeps the null Ascendant, MC and houses of a chart without birth time', async () => {
    const { api, fetchMock } = setup();
    const birth = { date: '1994-05-17', time: null, time_known: false, place: moscow };
    fetchMock.mockResolvedValue(json(201, { chart: { chart_id: 'c-1', birth, asc: null, mc: null, houses: null, planets: [] } }));

    const { chart } = await api.createChart(input);

    expect(chart).toEqual({ chart_id: 'c-1', birth, asc: null, mc: null, houses: null, planets: [] });
  });

  it('keeps the calculated Ascendant, MC and houses as they came', async () => {
    const { api, fetchMock } = setup();
    const angles = {
      asc: { sign: 'Дева', degree: 4, minute: 9 },
      mc: { sign: 'Близнецы', degree: 18, minute: 44 },
      houses: [{ house: 1, sign: 'Дева', degree: 4 }],
    };
    fetchMock.mockResolvedValue(json(201, { chart: { chart_id: 'c-1', ...angles } }));

    await expect(api.createChart(input)).resolves.toMatchObject({ chart: angles });
  });

  it('gives the screens safe shapes when the chart misses keys or has them malformed', async () => {
    const { api, fetchMock } = setup();
    fetchMock.mockResolvedValue(json(201, { chart: { chart_id: 'c-1', asc: 'Дева', houses: {}, planets: null } }));

    const { chart } = await api.createChart(input);

    expect(chart).toEqual({ chart_id: 'c-1', birth: {}, asc: null, mc: null, houses: null, planets: [] });
  });

  it('fails when the answer has no chart to show', async () => {
    const { api, fetchMock } = setup();
    fetchMock.mockResolvedValue(json(201, { mini_reading: { sun: '…' } }));
    await expect(api.createChart(input)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  it('keeps the warnings it has words for, in the server\'s order, and skips the rest: the server may add codes', async () => {
    const { api, fetchMock } = setup();
    const warnings = ['approximate_place', 'code_of_a_newer_server', 'no_birth_time', 7, 'no_birth_time'];
    // 200, not 201: the chart already existed. The body says the same.
    fetchMock.mockResolvedValueOnce(json(200, { chart: { chart_id: 'c-1' }, warnings, is_restored: true }));
    // A server older than contract 1.4.0 sends neither field.
    fetchMock.mockResolvedValueOnce(json(201, { chart: { chart_id: 'c-1' } }));

    await expect(api.createChart(input)).resolves.toMatchObject({ warnings: ['approximate_place', 'no_birth_time'], is_restored: true });
    await expect(api.createChart(input)).resolves.toMatchObject({ warnings: [], is_restored: false });
  });

  it('surfaces a validation problem with the server text and the fields it names', async () => {
    const { api, fetchMock } = setup();
    const fields = [
      { field: 'birth_date', message: 'Сервис доступен с 18 лет' },
      { field: 'consent', message: 'Без согласия на обработку данных мы не можем построить карту' },
    ];
    fetchMock.mockResolvedValue(
      json(422, { code: 'VALIDATION_FAILED', message: 'Сервис доступен с 18 лет', request_id: 'r-9', details: { field_errors: fields } }),
    );

    const error: unknown = await api.createChart(input).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: 'VALIDATION_FAILED', status: 422, serverMessage: 'Сервис доступен с 18 лет', requestId: 'r-9' });
    expect(fieldErrorsOf(error)).toEqual(fields);
  });
});

describe('getCurrentChart', () => {
  it('reads the chart like `POST /charts` does, and takes the server\'s 404 for «no chart yet», not for a failure', async () => {
    const { api, fetchMock } = setup();
    fetchMock
      .mockResolvedValueOnce(json(200, { chart: { chart_id: 'c-1' }, warnings: ['approximate_time'], is_restored: true }))
      .mockResolvedValueOnce(
        // The body apps/api sends when the user has no chart.
        json(404, { code: 'NOT_FOUND', message: 'Такой страницы нет. Обнови приложение.', request_id: 'r' }),
      )
      .mockResolvedValueOnce(json(500, { code: 'INTERNAL', message: 'Что-то сломалось на нашей стороне.', request_id: 'r' }));

    await expect(api.getCurrentChart()).resolves.toEqual({
      chart: { chart_id: 'c-1', birth: {}, asc: null, mc: null, houses: null, planets: [] },
      mini_reading: { sun: '', moon: '', asc: '', summary: '' },
      warnings: ['approximate_time'],
      wheel_url: '',
      is_restored: true,
    });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect([url, init?.method, init?.body]).toEqual(['/api/v1/charts/current', 'GET', undefined]);

    await expect(api.getCurrentChart()).resolves.toBeNull();
    await expect(api.getCurrentChart()).rejects.toMatchObject({ code: 'INTERNAL', status: 500 });
  });
});

describe('sendEvents', () => {
  const events: ClientEvent[] = [
    { name: 'app_open', occurred_at: '2026-11-10T12:00:00.000Z' },
    { name: 'screen_view', occurred_at: '2026-11-10T12:00:01.000Z', props: { step: 'welcome' } },
  ];

  it('posts the batch to the contract path under the `events` key, with the user\'s initData', async () => {
    const { api, fetchMock } = setup();
    fetchMock.mockResolvedValue(json(202, { accepted: 2 }));

    await expect(api.sendEvents(events)).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('/api/v1/events');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(init?.body as string)).toEqual({ events });
    expect(init?.headers).toMatchObject({ 'X-Telegram-Init-Data': 'init' });
    expect(init).not.toHaveProperty('keepalive');
  });

  it('asks the browser to deliver the batch without the page when the page is going away', async () => {
    const { api, fetchMock } = setup();
    fetchMock.mockResolvedValue(json(202, { accepted: 2 }));

    await api.sendEvents(events, { keepalive: true });

    expect(fetchMock.mock.calls[0]?.[1]).toHaveProperty('keepalive', true);
  });

  it('never repeats a batch, even where other calls are retried: twice delivered is twice counted', async () => {
    const { api, fetchMock } = setup({ retries: 2 });
    fetchMock.mockImplementation(() => Promise.resolve(json(503)));

    await expect(api.sendEvents(events)).rejects.toMatchObject({ status: 503 });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('getMe', () => {
  it('rejects a body that is not an object', async () => {
    const { api, fetchMock } = setup();
    fetchMock.mockResolvedValue(json(200, 'ok'));
    await expect(api.getMe()).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  it('takes access as granted only on the server\'s exact «true»: a missing or odd answer opens nothing', async () => {
    const { api, fetchMock } = setup();
    fetchMock.mockResolvedValue(
      json(200, { user_id: 'u', entitlements: { is_active: 'yes', full_report: 1, plan: 'month' }, subscription: { plan: 'month', is_active: 'true' } }),
    );

    const me = await api.getMe();

    expect(me.entitlements).toMatchObject({ is_active: false, full_report: false });
    expect(me.subscription).toMatchObject({ plan: 'month', is_active: false, expires_at: null, auto_renew: false });
    expect(me).toMatchObject({ has_chart: false, chart_id: null, latest_report_id: null, quotas: [] });
  });
});

describe('deleteMe', () => {
  it('sends DELETE /me once, whatever the answer: repeating it is the user\'s decision', async () => {
    const { api, fetchMock } = setup({ retries: 2 });
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));

    await expect(api.deleteMe()).resolves.toBeUndefined();
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect([url, init?.method]).toEqual(['/api/v1/me', 'DELETE']);

    fetchMock.mockImplementation(() => Promise.resolve(json(503)));
    await expect(api.deleteMe()).rejects.toMatchObject({ status: 503 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('createInvoice', () => {
  const invoice = { invoice_link: 'https://t.me/$abc', plan_code: 'one_149', stars: 149, is_subscription: false };

  it('posts the plan and the chart, and is never repeated by the client: the server counts invoices', async () => {
    const { api, fetchMock } = setup({ retries: 2 });
    fetchMock.mockResolvedValueOnce(json(201, invoice));

    await expect(api.createInvoice({ plan_code: 'one_149', chart_id: 'c-1' })).resolves.toEqual(invoice);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect([url, init?.method, init?.body]).toEqual(['/api/v1/billing/invoice', 'POST', JSON.stringify({ plan_code: 'one_149', chart_id: 'c-1' })]);

    fetchMock.mockImplementation(() => Promise.resolve(json(503)));
    await expect(api.createInvoice({ plan_code: 'one_149' })).rejects.toMatchObject({ status: 503 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['no link', { ...invoice, invoice_link: '' }],
    ['no price', { ...invoice, stars: undefined }],
    ['a price that is not a whole number of stars', { ...invoice, stars: 149.5 }],
  ])('does not take an answer with %s for an invoice', async (_name, body) => {
    const { api, fetchMock } = setup();
    fetchMock.mockResolvedValue(json(201, body));
    await expect(api.createInvoice({ plan_code: 'one_149' })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });
});

describe('reports', () => {
  const chapters = [
    { key: 'emotions', title: 'Эмоции', body_md: 'Вторая.', order: 1 },
    { key: 'core', title: 'Ядро', body_md: 'Первая.', order: 0 },
    { key: 'talents', title: 'Таланты', body_md: '   ', order: 2 },
  ];
  const body = { report_id: 'r-1', chart_id: 'c-1', type: 'full', status: 'generating', progress: 40, created_at: 'now', is_paid: true, sections: chapters };

  it('orders with the chart in the body and the idempotency key in the header', async () => {
    const { api, fetchMock } = setup();
    fetchMock.mockResolvedValue(json(202, { ...body, status: 'queued', progress: 0, sections: [] }));

    await expect(api.orderReport({ chart_id: 'c-1', type: 'full' }, 'key-1')).resolves.toMatchObject({ report_id: 'r-1', status: 'queued' });

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect([url, init?.method, init?.body]).toEqual(['/api/v1/reports', 'POST', JSON.stringify({ chart_id: 'c-1', type: 'full' })]);
    expect(init?.headers).toMatchObject({ 'Idempotency-Key': 'key-1' });
  });

  it('repeats an order after a 5xx with the same key: the second attempt is the same order', async () => {
    const { api, fetchMock } = setup({ retries: 1 });
    fetchMock.mockResolvedValueOnce(json(503)).mockResolvedValueOnce(json(202, body));

    await api.orderReport({ chart_id: 'c-1', type: 'full' }, 'key-1');

    expect(fetchMock.mock.calls.map(([, init]) => (init?.headers as Record<string, string>)['Idempotency-Key'])).toEqual(['key-1', 'key-1']);
  });

  it('reads a paid report: the chapters in the order to read them, one without a text left out, none made up', async () => {
    const { api, fetchMock } = setup();
    fetchMock.mockResolvedValue(json(200, body));

    const report = await api.getReport('r-1');

    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/v1/reports/r-1');
    expect(report.sections.map((section) => section.key)).toEqual(['core', 'emotions']);
    expect(report).toMatchObject({ status: 'generating', progress: 40, is_paid: true, teaser: '', pdf_url: null });
  });

  it('keeps every chapter that has a text, whatever its key: an unknown key, no key, the same key twice', async () => {
    const { api, fetchMock } = setup();
    const odd = [
      { key: 'karma', title: 'Карма', body_md: 'Глава под ключом, которого нет в контракте.', order: 0 },
      { title: 'Без ключа', body_md: 'Глава без ключа.', order: 1 },
      { key: 'karma', title: 'Карма, ещё раз', body_md: 'Вторая глава под тем же ключом.', order: 2 },
      { key: 'last', title: 'Без номера', body_md: 'Глава без номера остаётся на своём месте в списке.' },
    ];
    fetchMock.mockResolvedValue(json(200, { ...body, status: 'ready', progress: 100, sections: odd }));

    const { sections } = await api.getReport('r-1');

    expect(sections.map((section) => section.title)).toEqual(['Карма', 'Без ключа', 'Карма, ещё раз', 'Без номера']);
    // The screen tells chapters apart by the key: two of them must never share one.
    expect(new Set(sections.map((section) => section.key)).size).toBe(4);
    expect(sections[0]?.key).toBe('karma');
  });

  it('lets nothing of an unpaid report through but its opening: no chapters, no PDF, whatever the server sent', async () => {
    const { api, fetchMock } = setup();
    fetchMock.mockResolvedValue(json(200, { ...body, status: 'ready', is_paid: false, teaser: 'Начало.', pdf_url: '/pdf?sig=1' }));

    await expect(api.getReport('r-1')).resolves.toMatchObject({ is_paid: false, teaser: 'Начало.', sections: [], pdf_url: null });

    // «Paid» is the server's exact word, not anything truthy.
    fetchMock.mockResolvedValue(json(200, { ...body, is_paid: 'true' }));
    await expect(api.getReport('r-1')).resolves.toMatchObject({ is_paid: false, sections: [] });
  });

  it('does not guess at a status it does not know, and takes 402 on an order for what it is', async () => {
    const { api, fetchMock } = setup();
    fetchMock.mockResolvedValueOnce(json(200, { ...body, status: 'archived' }));
    await expect(api.getReport('r-1')).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });

    fetchMock.mockResolvedValueOnce(json(402, { code: 'PAYMENT_REQUIRED', message: 'Полный разбор — отдельная покупка.', request_id: 'r' }));
    await expect(api.orderReport({ chart_id: 'c-1', type: 'full' }, 'key-1')).rejects.toMatchObject({ code: 'PAYMENT_REQUIRED', status: 402 });
  });
});

describe('absoluteApiUrl', () => {
  const origin = 'https://app.test';

  it.each([
    ['charts/c-1/wheel.svg?sig=s', '', 'https://app.test/api/v1/charts/c-1/wheel.svg?sig=s'],
    ['/api/v1/charts/c-1/wheel.svg?sig=s', '', 'https://app.test/api/v1/charts/c-1/wheel.svg?sig=s'],
    ['charts/c-1/wheel.svg?sig=s', 'https://api.test', 'https://api.test/api/v1/charts/c-1/wheel.svg?sig=s'],
    ['https://cdn.test/w.svg?sig=s', 'https://api.test', 'https://cdn.test/w.svg?sig=s'],
  ])('resolves %s against base "%s"', (path, base, expected) => {
    expect(absoluteApiUrl(path, base, origin)).toBe(expected);
  });

  it('returns null for something that is not a URL', () => {
    expect(absoluteApiUrl('http://', '', origin)).toBeNull();
  });
});
