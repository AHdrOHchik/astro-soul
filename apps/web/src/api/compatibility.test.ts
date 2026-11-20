import { describe, expect, it, vi } from 'vitest';
import { createApi } from './index';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

function setup() {
  const fetchMock = vi.fn<typeof fetch>();
  const api = createApi({ baseUrl: '', getInitData: () => 'signed-init-data', fetch: fetchMock, retries: 2, retryDelayMs: () => 0 });
  return { api, fetchMock };
}

describe('compatibility API', () => {
  it('reads the server-owned quota with no-store', async () => {
    const { api, fetchMock } = setup();
    const response = { items: [], total: 0, limit: 20, offset: 0, quota: { kind: 'subscription', left: 0, resets_at: '2026-12-18T00:00:00Z' } };
    fetchMock.mockResolvedValue(json(200, response));

    await expect(api.getCompatibilities()).resolves.toEqual(response);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect([url, init?.method, init?.cache]).toEqual(['/api/v1/compatibility?limit=20&offset=0', 'GET', 'no-store']);
    expect(init?.headers).toMatchObject({ 'X-Telegram-Init-Data': 'signed-init-data' });
  });

  it('posts only the contract fields with one idempotency key and never automatically retries an order', async () => {
    const { api, fetchMock } = setup();
    const request = {
      chart_id: '11111111-1111-4111-8111-111111111111',
      relationship: 'friend' as const,
      partner: {
        birth_date: '1994-05-17',
        birth_time: null,
        place: { lat: 55.7963, lon: 49.1088, tz: 'Europe/Moscow' },
      },
    };
    fetchMock.mockResolvedValueOnce(json(202, { compatibility_id: '22222222-2222-4222-8222-222222222222', status: 'pending' }));

    await expect(api.orderCompatibility(request, 'key-compat-1')).resolves.toEqual({
      compatibility_id: '22222222-2222-4222-8222-222222222222', status: 'pending',
    });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect([url, init?.method, init?.body]).toEqual(['/api/v1/compatibility', 'POST', JSON.stringify(request)]);
    expect(init?.headers).toMatchObject({ 'Idempotency-Key': 'key-compat-1' });

    fetchMock.mockResolvedValue(json(503, { code: 'INTERNAL', message: 'Unavailable' }));
    await expect(api.orderCompatibility(request, 'key-compat-2')).rejects.toMatchObject({ status: 503 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('reads an item by its URL-encoded id and validates the response identity', async () => {
    const { api, fetchMock } = setup();
    const ready = {
      id: 'compatibility/one', status: 'ready', sections: [], warnings: [], created_at: '2026-11-10T12:00:00Z',
    };
    fetchMock.mockResolvedValueOnce(json(200, ready));
    await expect(api.getCompatibility('compatibility/one')).resolves.toEqual(ready);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/v1/compatibility/compatibility%2Fone');

    fetchMock.mockResolvedValueOnce(json(200, { ...ready, id: 'somebody-elses-id' }));
    await expect(api.getCompatibility('compatibility/one')).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });
});
