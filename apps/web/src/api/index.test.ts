import { describe, expect, it, vi } from 'vitest';
import { absoluteApiUrl, createApi, fieldErrorsOf, type ChartCreateRequest, type GeoPlace } from './index';

const moscow: GeoPlace = { name: 'Москва', region: null, country: 'RU', lat: 55.7558, lon: 37.6173, tz: 'Europe/Moscow' };

const json = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), { status });

function setup() {
  const fetchMock = vi.fn<typeof fetch>();
  const api = createApi({ baseUrl: '', getInitData: () => 'init', fetch: fetchMock, retries: 0 });
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
    fetchMock.mockResolvedValue(
      json(503, { code: 'GEO_NOT_FOUND', message: 'Геоданные сейчас недоступны.', request_id: 'r', details: { provider: 'nominatim' } }),
    );
    await expect(api.resolveGeo('Моск')).rejects.toMatchObject({
      code: 'GEO_NOT_FOUND',
      status: 503,
      serverMessage: 'Геоданные сейчас недоступны.',
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

  it('returns the reading and the wheel path as they came', async () => {
    const { api, fetchMock } = setup();
    const reading = { sun: 'Солнце в Телец, 26°17′', moon: 'Луна в Лев, 12°38′', asc: 'Асцендент в Дева, 15°03′', summary: 'Вместе' };
    const wheel = '/api/v1/charts/c-1/wheel.svg?sig=1767225600.abc123';
    fetchMock.mockResolvedValue(json(201, { chart: { chart_id: 'c-1' }, mini_reading: reading, wheel_url: wheel }));

    await expect(api.createChart(input)).resolves.toMatchObject({ mini_reading: reading, wheel_url: wheel });
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

describe('getMe', () => {
  it('rejects a body that is not an object', async () => {
    const { api, fetchMock } = setup();
    fetchMock.mockResolvedValue(json(200, 'ok'));
    await expect(api.getMe()).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
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
