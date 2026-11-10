import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { INIT_DATA_HEADER } from '../src/modules/auth/init-data';
import { createTestContext, type TestContext } from './test-app';
import { signInitData } from './init-data-fixture';
import { FICTIONAL_USER, TEST_BOT_TOKEN } from './test-env';
import { makeFakeAstro } from './fake-astro';
import type { GeoPlace } from '@astro-soul/shared';

let ctx: TestContext;

function initData(): string {
  return signInitData({ botToken: TEST_BOT_TOKEN, user: FICTIONAL_USER });
}

function resolve(body: unknown): request.Test {
  return request(ctx.app.getHttpServer())
    .post('/api/v1/geo/resolve')
    .set(INIT_DATA_HEADER, initData())
    .send(body as object);
}

beforeAll(async () => {
  ctx = await createTestContext({ astro: makeFakeAstro() });
});

afterAll(async () => {
  await ctx.close();
});

describe('POST /api/v1/geo/resolve', () => {
  it('находит город и отдаёт обязательный tz', async () => {
    const response = await resolve({ query: 'Моск' }).expect(200);

    const places = response.body as GeoPlace[];
    expect(Array.isArray(places)).toBe(true);
    expect(places[0]).toMatchObject({ name: 'Москва', country: 'RU', tz: 'Europe/Moscow' });
    expect(typeof places[0]?.lat).toBe('number');
  });

  it('понимает латиницу и сокращения из alias', async () => {
    const latin = await resolve({ query: 'Saint' }).expect(200);
    expect((latin.body as GeoPlace[]).map((p) => p.name)).toContain('Санкт-Петербург');

    const short = await resolve({ query: 'спб' }).expect(200);
    expect((short.body as GeoPlace[]).map((p) => p.name)).toContain('Санкт-Петербург');
  });

  it('пустой результат — это 200 и пустой массив, а не 404', async () => {
    const response = await resolve({ query: 'Атлантида' }).expect(200);

    expect(response.body).toEqual([]);
  });

  it('до трёх символов не ищет и не ругается', async () => {
    const response = await resolve({ query: 'Мо' }).expect(200);
    expect(response.body).toEqual([]);
  });

  it('уважает limit', async () => {
    const response = await resolve({ query: 'Нов', limit: 2 }).expect(200);
    expect((response.body as GeoPlace[]).length).toBeLessThanOrEqual(2);
  });

  it('пустой запрос → 422 с field_errors по query', async () => {
    const response = await resolve({ query: '   ' }).expect(422);

    expect(response.body.code).toBe('VALIDATION_FAILED');
    expect(response.body.details.field_errors).toEqual([
      { field: 'query', message: expect.any(String) as string },
    ]);
  });

  it('без initData → 401', async () => {
    await request(ctx.app.getHttpServer())
      .post('/api/v1/geo/resolve')
      .send({ query: 'Москва' })
      .expect(401);
  });
});
