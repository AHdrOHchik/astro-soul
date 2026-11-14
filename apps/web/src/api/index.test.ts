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

describe('getForecast', () => {
  const CHART = '00000000-0000-4000-8000-00000000c0de';
  const body = { date: '2026-11-10', text: 'Спокойный день. Доделай начатое.', focus: 'career', is_paid: true, generated_at: '2026-11-10T00:02:11.000Z' };

  it('reads the forecast of the chart named in the query, and keeps only what the screens show', async () => {
    const { api, fetchMock } = setup();
    fetchMock.mockResolvedValueOnce(json(200, body));

    await expect(api.getForecast(CHART)).resolves.toEqual({ date: '2026-11-10', text: 'Спокойный день. Доделай начатое.', focus: 'career', is_paid: true });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect([url, init?.method, init?.body]).toEqual([`/api/v1/engagement/forecast?chart_id=${CHART}`, 'GET', undefined]);
  });

  it('writes the chart into the query as a value, not as a part of the address', async () => {
    const { api, fetchMock } = setup();
    fetchMock.mockResolvedValueOnce(json(200, body));
    await api.getForecast('a b&x=1');
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/v1/engagement/forecast?chart_id=a%20b%26x%3D1');
  });

  it.each([
    // The words of apps/api for a forecast its nightly job has not written yet.
    ['the Problem of apps/api', json(404, { code: 'NOT_FOUND', message: 'Прогноз на сегодня ещё готовится. Загляни чуть позже', request_id: 'r' })],
    ['a bare 404', json(404)],
  ])('takes %s for «none yet», not for a failure', async (_name, response) => {
    const { api, fetchMock } = setup({ retries: 2 });
    fetchMock.mockResolvedValue(response);
    await expect(api.getForecast(CHART)).resolves.toBeNull();
    // An answer, not a failure to try again: asked once.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps real failures as errors', async () => {
    const { api, fetchMock } = setup();
    fetchMock
      .mockResolvedValueOnce(json(500, { code: 'INTERNAL', message: 'Что-то сломалось на нашей стороне.', request_id: 'r' }))
      .mockResolvedValueOnce(json(401))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await expect(api.getForecast(CHART)).rejects.toMatchObject({ code: 'INTERNAL', status: 500 });
    await expect(api.getForecast(CHART)).rejects.toMatchObject({ code: 'UNAUTHORIZED', status: 401 });
    await expect(api.getForecast(CHART)).rejects.toMatchObject({ code: 'NETWORK' });
  });

  it.each([
    ['a focus this build has no word for', { ...body, focus: 'travel' }],
    ['no focus', { ...body, focus: null }],
    ['a focus that is not a code', { ...body, focus: 7 }],
    ['the field left out', { date: body.date, text: body.text, is_paid: true }],
  ])('has no focus for %s: a code is never shown raw', async (_name, answer) => {
    const { api, fetchMock } = setup();
    fetchMock.mockResolvedValue(json(200, answer));
    await expect(api.getForecast(CHART)).resolves.toMatchObject({ focus: null, text: body.text });
  });

  it.each([
    ['true', true, true],
    ['false', false, false],
    ['the field left out', undefined, false],
    ['the word "true"', 'true', false],
    ['1', 1, false],
  ])('is the full forecast only when the server says exactly `true` (is_paid: %s)', async (_name, isPaid, expected) => {
    const { api, fetchMock } = setup();
    fetchMock.mockResolvedValue(json(200, { ...body, is_paid: isPaid }));
    await expect(api.getForecast(CHART)).resolves.toMatchObject({ is_paid: expected });
  });

  it.each([
    ['no text', { ...body, text: undefined }],
    ['an empty text', { ...body, text: '  ' }],
    ['no date', { ...body, date: undefined }],
    ['a list', [body]],
    ['nothing', null],
  ])('does not take an answer with %s for a forecast', async (_name, answer) => {
    const { api, fetchMock } = setup();
    fetchMock.mockResolvedValue(json(200, answer));
    await expect(api.getForecast(CHART)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });
});

describe('ask', () => {
  const input = { chart_id: '00000000-0000-4000-8000-00000000c0de', question: 'На что опереться в работе?' };
  const quota = { code: 'ask_daily', used: 3, limit: 5, reset_at: '2026-11-10T21:00:00.000Z' };

  it('posts the chart and the question, and returns the answer with what it rests on', async () => {
    const { api, fetchMock } = setup();
    fetchMock.mockResolvedValueOnce(json(200, { answer: 'Опора — в привычке доводить начатое.', based_on: ['Солнце в Тельце', 'Луна в Раке'], quota }));

    await expect(api.ask(input)).resolves.toEqual({ answer: 'Опора — в привычке доводить начатое.', based_on: ['Солнце в Тельце', 'Луна в Раке'] });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect([url, init?.method, init?.body]).toEqual(['/api/v1/engagement/ask', 'POST', JSON.stringify(input)]);
  });

  it.each([
    ['a 503', () => Promise.resolve(json(503))],
    ['a 500', () => Promise.resolve(json(500, { code: 'INTERNAL', message: 'Что-то сломалось на нашей стороне.', request_id: 'r' }))],
    ['a lost connection', () => Promise.reject(new TypeError('Failed to fetch'))],
  ])('is never repeated by the client after %s: a question that got through may already be counted', async (_name, answer) => {
    const { api, fetchMock } = setup({ retries: 3 });
    fetchMock.mockImplementation(answer);
    await expect(api.ask(input)).rejects.toBeDefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('takes a refusal to speak on a topic for what the server sent it as: an answer', async () => {
    const { api, fetchMock } = setup();
    const refusal = 'Про это я не могу: здоровье, смерть, гарантии денег и юридические вопросы — не моя роль.';
    fetchMock.mockResolvedValueOnce(json(200, { answer: refusal, based_on: [], quota }));
    await expect(api.ask(input)).resolves.toEqual({ answer: refusal, based_on: [] });
  });

  it.each([
    ['left out', undefined],
    ['null', null],
    ['not a list', 'Солнце в Тельце'],
  ])('rests on nothing when `based_on` is %s', async (_name, basedOn) => {
    const { api, fetchMock } = setup();
    fetchMock.mockResolvedValue(json(200, { answer: 'Ответ.', based_on: basedOn }));
    await expect(api.ask(input)).resolves.toEqual({ answer: 'Ответ.', based_on: [] });
  });

  it('drops from `based_on` what is not a line of text', async () => {
    const { api, fetchMock } = setup();
    fetchMock.mockResolvedValue(json(200, { answer: 'Ответ.', based_on: ['Солнце в Тельце', '', '  ', 7, null, { name: 'Луна' }, 'Луна в Раке'] }));
    await expect(api.ask(input)).resolves.toEqual({ answer: 'Ответ.', based_on: ['Солнце в Тельце', 'Луна в Раке'] });
  });

  it.each([
    ['no answer', { based_on: [] }],
    ['an empty answer', { answer: '   ', based_on: [] }],
    ['an answer that is not a text', { answer: { text: 'Ответ.' }, based_on: [] }],
    ['nothing', null],
  ])('does not take a body with %s for an answer', async (_name, body) => {
    const { api, fetchMock } = setup();
    fetchMock.mockResolvedValue(json(200, body));
    await expect(api.ask(input)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  it('passes on what the server refused the question with: the used-up limit with its reset, the rejected field, a missing chart', async () => {
    const { api, fetchMock } = setup();
    const exhausted = 'На сегодня вопросы закончились. Лимит обновится в полночь по месту рождения';
    fetchMock
      .mockResolvedValueOnce(
        json(429, { code: 'QUOTA_EXCEEDED', message: exhausted, request_id: 'r-429', details: { quota_code: 'ask_daily', reset_at: '2026-11-10T21:00:00.000Z', unlimited: false } }),
      )
      .mockResolvedValueOnce(
        json(422, { code: 'VALIDATION_FAILED', message: 'Вопрос — от 3 до 500 знаков', request_id: 'r-422', details: { field_errors: [{ field: 'question', message: 'Вопрос — от 3 до 500 знаков' }] } }),
      )
      .mockResolvedValueOnce(json(404, { code: 'NOT_FOUND', message: 'Такой карты нет. Построй карту заново', request_id: 'r-404' }));

    await expect(api.ask(input)).rejects.toMatchObject({
      code: 'QUOTA_EXCEEDED',
      status: 429,
      serverMessage: exhausted,
      details: { quota_code: 'ask_daily', reset_at: '2026-11-10T21:00:00.000Z' },
    });
    const rejected: unknown = await api.ask(input).catch((error: unknown) => error);
    expect(rejected).toMatchObject({ code: 'VALIDATION_FAILED', status: 422, requestId: 'r-422' });
    expect(fieldErrorsOf(rejected)).toEqual([{ field: 'question', message: 'Вопрос — от 3 до 500 знаков' }]);
    // Unlike a forecast, a question has no «none yet»: a 404 here is an error for the screen to read.
    await expect(api.ask(input)).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
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

describe('getForecast: the focus under the names the app gives the codes of the contract', () => {
  const CHART = '00000000-0000-4000-8000-00000000c0de';
  const body = { date: '2026-11-10', text: 'Спокойный день.', is_paid: true };
  const focusOf = async (code: unknown) => {
    const { api, fetchMock } = setup();
    fetchMock.mockResolvedValue(json(200, { ...body, focus: code }));
    return (await api.getForecast(CHART))?.focus;
  };

  it('the server\'s `health` is `wellbeing` in the app: the word of the wire goes no further than the API client', async () => {
    expect(await focusOf('health')).toBe('wellbeing');
  });

  it.each(['career', 'love', 'money', 'self'])('`%s` keeps its name', async (code) => {
    expect(await focusOf(code)).toBe(code);
  });

  it.each(['wellbeing', 'Health', 'toString', 'constructor', '__proto__', ''])('%j is not a code of the server: no focus', async (code) => {
    expect(await focusOf(code)).toBeNull();
  });
});
