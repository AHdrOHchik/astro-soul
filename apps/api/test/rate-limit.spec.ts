import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { INIT_DATA_HEADER } from '../src/modules/auth/init-data';
import { WindowLimiter } from '../src/common/rate-limit.middleware';
import { createTestContext, type TestContext } from './test-app';
import { signInitData } from './init-data-fixture';
import { FICTIONAL_USER, TEST_BOT_TOKEN } from './test-env';
import { makeFakeAstro } from './fake-astro';

describe('WindowLimiter', () => {
  it('пропускает до лимита и блокирует дальше, окно сдвигается', () => {
    let now = 0;
    const limiter = new WindowLimiter(() => now);

    expect(limiter.hit('k', 2).allowed).toBe(true);
    expect(limiter.hit('k', 2).allowed).toBe(true);

    const blocked = limiter.hit('k', 2);
    expect(blocked.allowed).toBe(false);
    expect(blocked.remaining).toBe(0);
    expect(blocked.resetSeconds).toBeGreaterThan(0);

    now = 61_000;
    expect(limiter.hit('k', 2).allowed).toBe(true);
  });

  it('ключи не пересекаются', () => {
    const limiter = new WindowLimiter(() => 0);
    expect(limiter.hit('a', 1).allowed).toBe(true);
    expect(limiter.hit('a', 1).allowed).toBe(false);
    expect(limiter.hit('b', 1).allowed).toBe(true);
  });
});

describe('лимит запросов через API', () => {
  const saved = { ...process.env };
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestContext({ astro: makeFakeAstro(), env: { RATE_LIMIT_PER_MIN: '2' } });
  });

  afterAll(async () => {
    await ctx.close();
  });

  afterEach(() => {
    // Не даём лимитам протечь в другие файлы того же воркера.
    process.env['RATE_LIMIT_PER_MIN'] = saved['RATE_LIMIT_PER_MIN'];
  });

  it('третий запрос в минуту → 429 RATE_LIMITED с заголовками RateLimit-*', async () => {
    const initData = signInitData({ botToken: TEST_BOT_TOKEN, user: FICTIONAL_USER });
    const agent = request(ctx.app.getHttpServer());

    const first = await agent.get('/api/v1/me').set(INIT_DATA_HEADER, initData).expect(200);
    expect(first.headers['ratelimit-limit']).toBe('2');

    await agent.get('/api/v1/me').set(INIT_DATA_HEADER, initData).expect(200);

    const blocked = await agent.get('/api/v1/me').set(INIT_DATA_HEADER, initData).expect(429);
    expect(blocked.body.code).toBe('RATE_LIMITED');
    expect(blocked.headers['retry-after']).toBeDefined();
  });
});
