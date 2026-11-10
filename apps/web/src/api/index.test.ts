import { describe, expect, it, vi } from 'vitest';
import { absoluteApiUrl, createApi, type ChartCreateRequest, type GeoPlace } from './index';

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

  it.each([
    ['a GEO_NOT_FOUND problem', json(404, { code: 'GEO_NOT_FOUND', message: 'Не нашли', request_id: 'r' })],
    ['an empty list', json(200, [])],
  ])('treats %s as "nothing found"', async (_name, response) => {
    const { api, fetchMock } = setup();
    fetchMock.mockResolvedValue(response);
    await expect(api.resolveGeo('Ыыы')).resolves.toEqual([]);
  });

  it.each([
    // What the API answers for a route it does not have.
    ['a NOT_FOUND problem', json(404, { code: 'NOT_FOUND', message: 'Cannot POST /api/v1/geo/resolve', request_id: 'r' })],
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
  const input: ChartCreateRequest = { birth_date: '1994-05-17', birth_time: null, birth_place: moscow };

  it('sends the request unchanged, including a null time and the full place', async () => {
    const { api, fetchMock } = setup();
    fetchMock.mockResolvedValue(json(201, { chart: { chart_id: 'c-1', planets: [] } }));

    await expect(api.createChart(input)).resolves.toMatchObject({ chart: { chart_id: 'c-1' } });

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('/api/v1/charts');
    expect(JSON.parse(init?.body as string)).toEqual(input);
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

  it('surfaces validation problems with the server text', async () => {
    const { api, fetchMock } = setup();
    fetchMock.mockResolvedValue(json(422, { code: 'VALIDATION_FAILED', message: 'Дата в будущем', request_id: 'r-9' }));
    await expect(api.createChart(input)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      serverMessage: 'Дата в будущем',
      requestId: 'r-9',
    });
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
