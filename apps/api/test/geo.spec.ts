import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
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

  it('ищет с двух символов', async () => {
    const response = await resolve({ query: 'Мо' }).expect(200);
    expect((response.body as GeoPlace[]).map((place) => place.name)).toContain('Москва');
  });

  it('один символ → 422 «Введи хотя бы 2 буквы», а не пустой массив', async () => {
    const response = await resolve({ query: 'М' }).expect(422);

    expect(response.body.code).toBe('VALIDATION_FAILED');
    expect(response.body.details.field_errors).toEqual([
      { field: 'query', message: 'Введи хотя бы 2 буквы' },
    ]);
  });

  it('уважает limit', async () => {
    const response = await resolve({ query: 'Нов', limit: 2 }).expect(200);
    expect((response.body as GeoPlace[]).length).toBeLessThanOrEqual(2);
  });

  it('limit вне 1…10 → 422, а не обрезка (контракт 1.4.0)', async () => {
    for (const limit of [0, 11, -1, 100]) {
      const response = await resolve({ query: 'Москва', limit }).expect(422);
      expect(response.body.code).toBe('VALIDATION_FAILED');
      expect(response.body.details.field_errors).toEqual([
        { field: 'limit', message: expect.any(String) as string },
      ]);
    }
  });

  it('limit не целое число → 422', async () => {
    const response = await resolve({ query: 'Москва', limit: 2.5 }).expect(422);
    expect(response.body.details.field_errors[0]).toMatchObject({ field: 'limit' });
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

describe('POST /api/v1/geo/resolve: провайдер недоступен', () => {
  const saved = { ...process.env };
  let providerCtx: TestContext;

  beforeAll(async () => {
    providerCtx = await createTestContext({
      astro: makeFakeAstro(),
      env: { GEO_PROVIDER: 'nominatim', GEO_CONTACT_EMAIL: '' },
    });
  });

  afterAll(async () => {
    await providerCtx.close();
    process.env['GEO_PROVIDER'] = saved['GEO_PROVIDER'];
    process.env['GEO_CONTACT_EMAIL'] = saved['GEO_CONTACT_EMAIL'];
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function resolveWith(query: string): request.Test {
    return request(providerCtx.app.getHttpServer())
      .post('/api/v1/geo/resolve')
      .set(INIT_DATA_HEADER, initData())
      .send({ query });
  }

  it('нет контакта для User-Agent → 503 GEO_NOT_FOUND, reason=not_configured', async () => {
    const response = await resolveWith('Атлан').expect(503);

    expect(response.body.code).toBe('GEO_NOT_FOUND');
    expect(response.body.details.reason).toBe('not_configured');
    expect(response.body.message).toBe(
      'Поиск городов временно недоступен. Попробуй ещё раз через минуту.',
    );
  });

  it('провайдер отвечает ошибкой → reason=provider_unavailable', async () => {
    process.env['GEO_CONTACT_EMAIL'] = 'support@example.com';
    // Контекст читает env при создании, поэтому проверяем сервис напрямую.
    vi.stubGlobal('fetch', () => Promise.resolve(new Response('nope', { status: 500 })));

    const { GeoService } = await import('../src/modules/geo/geo.service');
    const { JsonLogger } = await import('../src/common/logger');
    const env = (await import('../src/config/env')).loadEnv();
    const service = new GeoService(
      { ...env, GEO_PROVIDER: 'nominatim', GEO_CONTACT_EMAIL: 'a@b.c' },
      new JsonLogger('error'),
    );

    await expect(service.resolve('Атлан', 5)).rejects.toMatchObject({
      details: { reason: 'provider_unavailable' },
    });
  });

  it('таймаут провайдера → reason=provider_timeout', async () => {
    const timeout = new Error('The operation was aborted');
    timeout.name = 'TimeoutError';
    vi.stubGlobal('fetch', () => Promise.reject(timeout));

    const { GeoService } = await import('../src/modules/geo/geo.service');
    const { JsonLogger } = await import('../src/common/logger');
    const env = (await import('../src/config/env')).loadEnv();
    const service = new GeoService(
      { ...env, GEO_PROVIDER: 'nominatim', GEO_CONTACT_EMAIL: 'a@b.c' },
      new JsonLogger('error'),
    );

    await expect(service.resolve('Атлан', 5)).rejects.toMatchObject({
      details: { reason: 'provider_timeout' },
    });
  });
});
