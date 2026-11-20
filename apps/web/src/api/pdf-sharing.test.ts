import { describe, expect, it, vi } from 'vitest';
import { createApi } from './index';

const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
function setup() {
  const fetcher = vi.fn<typeof fetch>();
  const api = createApi({ baseUrl: '', getInitData: () => 'init', fetch: fetcher, retries: 2, retryDelayMs: () => 0 });
  return { api, fetcher };
}

describe('report PDF and share-card API contracts', () => {
  it('POSTs PDF job creation once with a mandatory idempotency key', async () => {
    const { api, fetcher } = setup();
    fetcher.mockResolvedValue(response({ status: 'pending' }, 202));
    await expect(api.createReportPdf('report/one', 'idem-pdf-1')).resolves.toEqual({ status: 'pending' });
    const [url, init] = fetcher.mock.calls[0] ?? [];
    expect(url).toBe('/api/v1/reports/report%2Fone/pdf');
    expect(init?.method).toBe('POST');
    expect(new Headers(init?.headers).get('Idempotency-Key')).toBe('idem-pdf-1');
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('GETs fresh PDF status with no-store and accepts a fresh ready URL', async () => {
    const { api, fetcher } = setup();
    const ready = { status: 'ready', url: '/api/v1/files/fresh.pdf?sig=new', expires_at: '2026-11-16T10:00:00Z' };
    fetcher.mockResolvedValue(response(ready));
    await expect(api.getReportPdf('report-1')).resolves.toEqual(ready);
    const [url, init] = fetcher.mock.calls[0] ?? [];
    expect(url).toBe('/api/v1/reports/report-1/pdf');
    expect([init?.method, init?.cache]).toEqual(['GET', 'no-store']);
  });

  it('creates a server card using only its permitted kind and never retries creation automatically', async () => {
    const { api, fetcher } = setup();
    const card = { url: '/private/signed.png?sig=secret', share_url: 'https://t.me/astro_soul_bot?start=sh_k7m2p9x4qz', expires_at: '2026-11-16T10:00:00Z', caption: 'Exact server caption' };
    fetcher.mockResolvedValue(response(card));
    await expect(api.createShareCard('day')).resolves.toEqual(card);
    const [url, init] = fetcher.mock.calls[0] ?? [];
    expect(url).toBe('/api/v1/share/card');
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe(JSON.stringify({ kind: 'day' }));
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
