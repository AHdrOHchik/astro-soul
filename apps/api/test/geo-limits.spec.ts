import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { INIT_DATA_HEADER } from '../src/modules/auth/init-data';
import { createTestContext, type TestContext } from './test-app';
import { signInitData } from './init-data-fixture';
import { FICTIONAL_USER, TEST_BOT_TOKEN } from './test-env';
import { EnvValidationError, loadEnv } from '../src/config/env';
import { makeFakeAstro } from './fake-astro';
import type { GeoPlace, Me } from '@astro-soul/shared';

/**
 * Границы геопоиска живут в окружении (итерация 21).
 *
 * Проверяем всю цепочку: `.env` → валидация на старте → поведение
 * `POST /geo/resolve` → `GET /me.limits` для клиента. Числа в коде не
 * участвуют: если кто-то вернёт константу, тест с нестандартным окружением
 * развалится.
 */

function initData(): string {
  return signInitData({ botToken: TEST_BOT_TOKEN, user: FICTIONAL_USER });
}

function resolve(ctx: TestContext, body: unknown): request.Test {
  return request(ctx.app.getHttpServer())
    .post('/api/v1/geo/resolve')
    .set(INIT_DATA_HEADER, initData())
    .send(body as object);
}

async function me(ctx: TestContext): Promise<Me> {
  const response = await request(ctx.app.getHttpServer())
    .get('/api/v1/me')
    .set(INIT_DATA_HEADER, initData())
    .expect(200);
  return response.body as Me;
}

describe('дефолты совпадают с прежними числами в коде', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestContext({ astro: makeFakeAstro() });
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('GET /me отдаёт limits 2/120 по умолчанию', async () => {
    const body = await me(ctx);
    expect(body.limits).toEqual({ geo_min_query_length: 2, geo_max_query_length: 120 });
  });

  it('query=а → 422 (минимум из окружения)', async () => {
    const response = await resolve(ctx, { query: 'а' }).expect(422);
    expect(response.body.details.field_errors[0]).toMatchObject({ field: 'query' });
  });
});

describe('значения из окружения управляют и поиском, и GET /me', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestContext({
      astro: makeFakeAstro(),
      env: {
        GEO_MIN_QUERY_LENGTH: '3',
        GEO_MAX_QUERY_LENGTH: '9',
        GEO_DEFAULT_LIMIT: '2',
        GEO_MAX_LIMIT: '3',
      },
    });
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('GET /me отдаёт ровно то, что в окружении', async () => {
    const body = await me(ctx);
    expect(body.limits).toEqual({ geo_min_query_length: 3, geo_max_query_length: 9 });
  });

  it('два символа теперь мало: 422 называет серверный минимум', async () => {
    const response = await resolve(ctx, { query: 'Мо' }).expect(422);
    expect(response.body.details.reason).toBe('geo_query_too_short');
    expect(response.body.details.field_errors).toEqual([
      { field: 'query', message: 'Введи хотя бы 3 символа' },
    ]);
  });

  it('десять символов теперь много: 422 называет серверный максимум', async () => {
    const response = await resolve(ctx, { query: 'Москвагород' }).expect(422);
    expect(response.body.details.reason).toBe('geo_query_too_long');
  });

  it('без limit — GEO_DEFAULT_LIMIT, с limit=999 — GEO_MAX_LIMIT, и всё это 200', async () => {
    const byDefault = await resolve(ctx, { query: 'Нов' }).expect(200);
    expect((byDefault.body as GeoPlace[]).length).toBe(2);

    const capped = await resolve(ctx, { query: 'Нов', limit: 999 }).expect(200);
    expect((capped.body as GeoPlace[]).length).toBe(3);
  });
});

describe('валидация окружения на старте', () => {
  const valid = {
    DATABASE_URL: 'postgres://x',
    TELEGRAM_BOT_TOKEN: '123456789:test-token',
    PSEUDONYM_PEPPER: 'p'.repeat(40),
  };

  it('без переменных — прежние 2/120/5/10', () => {
    const env = loadEnv(valid);
    expect(env.GEO_MIN_QUERY_LENGTH).toBe(2);
    expect(env.GEO_MAX_QUERY_LENGTH).toBe(120);
    expect(env.GEO_DEFAULT_LIMIT).toBe(5);
    expect(env.GEO_MAX_LIMIT).toBe(10);
  });

  it('мусор вместо числа → ошибка называет переменную', () => {
    expect(() => loadEnv({ ...valid, GEO_MIN_QUERY_LENGTH: 'два' })).toThrow(
      EnvValidationError,
    );
    try {
      loadEnv({ ...valid, GEO_MIN_QUERY_LENGTH: 'два' });
    } catch (error) {
      expect((error as EnvValidationError).missing).toEqual(['GEO_MIN_QUERY_LENGTH']);
    }
  });

  it('минимум больше максимума → ошибка называет переменную, которую править', () => {
    try {
      loadEnv({
        ...valid,
        GEO_MIN_QUERY_LENGTH: '10',
        GEO_MAX_QUERY_LENGTH: '4',
      });
      throw new Error('окружение должно было не пройти');
    } catch (error) {
      expect(error).toBeInstanceOf(EnvValidationError);
      expect((error as EnvValidationError).missing).toEqual(['GEO_MAX_QUERY_LENGTH']);
    }
  });

  it('потолок меньше значения по умолчанию → ошибка называет GEO_MAX_LIMIT', () => {
    try {
      loadEnv({
        ...valid,
        GEO_DEFAULT_LIMIT: '7',
        GEO_MAX_LIMIT: '3',
      });
      throw new Error('окружение должно было не пройти');
    } catch (error) {
      expect(error).toBeInstanceOf(EnvValidationError);
      expect((error as EnvValidationError).missing).toEqual(['GEO_MAX_LIMIT']);
    }
  });

  it('ноль и отрицательное не проходят: GEO_MIN_QUERY_LENGTH ≥ 1', () => {
    expect(() => loadEnv({ ...valid, GEO_MIN_QUERY_LENGTH: '0' })).toThrow(
      EnvValidationError,
    );
    expect(() => loadEnv({ ...valid, GEO_DEFAULT_LIMIT: '-1' })).toThrow(
      EnvValidationError,
    );
  });
});
