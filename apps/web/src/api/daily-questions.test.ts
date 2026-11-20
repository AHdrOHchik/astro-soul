import { describe, expect, it, vi } from 'vitest';
import { createApi } from './index';

const response = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
function setup() {
  const fetcher = vi.fn<typeof fetch>();
  return { api: createApi({ baseUrl: '', getInitData: () => 'init', fetch: fetcher, retries: 0 }), fetcher };
}

describe('round30 API routes', () => {
  it('reads the server-owned daily forecast without query parameters', async () => {
    const { api, fetcher } = setup();
    const body = { date: '2026-11-15', timezone: 'Europe/Amsterdam', status: 'facts_only', access: 'facts_only', sections: [], chars: 0, warnings: [], facts: { moon_sign: 'Лев', moon_phase: 'растущая', illumination: 0.536 }, disclaimer: 'Текст сервера.' };
    fetcher.mockResolvedValue(response(body));
    await expect(api.getForecastToday()).resolves.toEqual(body);
    expect(fetcher.mock.calls[0]?.[0]).toBe('/api/v1/forecast/today');
    expect(fetcher.mock.calls[0]?.[1]?.method).toBe('GET');
  });
  it('lists a maximum of twenty questions and URL-encodes an id when reading one', async () => {
    const { api, fetcher } = setup();
    fetcher.mockResolvedValue(response({ items: [], quota: { used: 0, limit: 3, resets_at: '2026-11-16T00:00:00Z' } }));
    await api.listQuestions(50);
    expect(fetcher.mock.calls[0]?.[0]).toBe('/api/v1/questions?limit=20');
    fetcher.mockResolvedValue(response({ id: 'question-id', status: 'pending' }));
    await api.getQuestion('question-id');
    expect(fetcher.mock.calls[1]?.[0]).toBe('/api/v1/questions/question-id');
  });
  it('posts once with an idempotency key and the question payload', async () => {
    const { api, fetcher } = setup();
    fetcher.mockResolvedValue(response({ id: 'question-id', status: 'pending', quota: { used: 1, limit: 3, resets_at: '2026-11-16T00:00:00Z' } }));
    await api.createQuestion('Как распределить силы?', 'key-1');
    const [url, init] = fetcher.mock.calls[0] ?? [];
    expect(url).toBe('/api/v1/questions');
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe(JSON.stringify({ question: 'Как распределить силы?' }));
    expect(new Headers(init?.headers).get('Idempotency-Key')).toBe('key-1');
  });
});
