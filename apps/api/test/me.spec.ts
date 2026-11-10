import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { INIT_DATA_HEADER } from '../src/modules/auth/init-data';
import { userIdFromTelegramId } from '../src/modules/users/pseudonym';
import { createTestContext, truncateAll, type TestContext } from './test-app';
import { signInitData } from './init-data-fixture';
import { FICTIONAL_USER, TEST_BOT_TOKEN, TEST_PEPPER } from './test-env';
import type { Me } from '@astro-soul/shared';

const OTHER_BOT_TOKEN = '987654321:ANOTHER-BOT-TOKEN-for-tests';

let ctx: TestContext;

function validInitData(authDate?: number): string {
  return signInitData({
    botToken: TEST_BOT_TOKEN,
    user: FICTIONAL_USER,
    ...(authDate === undefined ? {} : { authDate }),
  });
}

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  await truncateAll(ctx.db);
});

describe('GET /api/v1/health', () => {
  it('отвечает без авторизации и сообщает состояние БД', async () => {
    const response = await request(ctx.app.getHttpServer()).get('/api/v1/health').expect(200);

    expect(response.body).toMatchObject({ status: 'ok', db: 'ok', llm: 'unknown' });
    expect(typeof response.body.version).toBe('string');
  });
});

describe('GET /api/v1/me — авторизация', () => {
  it('пустой заголовок → 401 UNAUTHORIZED в формате problem+json', async () => {
    const response = await request(ctx.app.getHttpServer())
      .get('/api/v1/me')
      .set(INIT_DATA_HEADER, '')
      .expect(401);

    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(response.body).toMatchObject({ code: 'UNAUTHORIZED' });
    expect(typeof response.body.message).toBe('string');
    expect(response.body.message.length).toBeGreaterThan(0);
    expect(response.body.request_id).toBe(response.headers['x-request-id']);
  });

  it('нет заголовка вовсе → 401', async () => {
    await request(ctx.app.getHttpServer()).get('/api/v1/me').expect(401);
  });

  it('битая подпись → 401', async () => {
    const tampered = validInitData().replace(/hash=[0-9a-f]+/, 'hash=' + 'b'.repeat(64));

    const response = await request(ctx.app.getHttpServer())
      .get('/api/v1/me')
      .set(INIT_DATA_HEADER, tampered)
      .expect(401);

    expect(response.body.details).toMatchObject({ reason: 'signature_mismatch' });
  });

  it('чужой user_id (подпись токеном другого бота) → 401', async () => {
    const foreign = signInitData({ botToken: OTHER_BOT_TOKEN, user: FICTIONAL_USER });

    await request(ctx.app.getHttpServer())
      .get('/api/v1/me')
      .set(INIT_DATA_HEADER, foreign)
      .expect(401);
  });

  it('auth_date старше 24 часов → 401', async () => {
    const stale = validInitData(Math.floor(Date.now() / 1000) - 24 * 60 * 60 - 60);

    const response = await request(ctx.app.getHttpServer())
      .get('/api/v1/me')
      .set(INIT_DATA_HEADER, stale)
      .expect(401);

    expect(response.body.details).toMatchObject({ reason: 'auth_date_too_old' });
  });

  it('middleware закрывает весь /api/v1/*, а не только /me', async () => {
    // Маршрута ещё нет — но 401, а не 404: значит проверка сработала раньше роутинга.
    await request(ctx.app.getHttpServer()).get('/api/v1/charts').expect(401);
  });

  it('с валидным initData неизвестный маршрут даёт 404 NOT_FOUND', async () => {
    const response = await request(ctx.app.getHttpServer())
      .get('/api/v1/unknown-route')
      .set(INIT_DATA_HEADER, validInitData())
      .expect(404);

    expect(response.body).toMatchObject({ code: 'NOT_FOUND' });
  });

  it('возвращает клиентский request_id, если он безопасного формата', async () => {
    const response = await request(ctx.app.getHttpServer())
      .get('/api/v1/me')
      .set(INIT_DATA_HEADER, '')
      .set('X-Request-Id', 'qa-req-0001')
      .expect(401);

    expect(response.headers['x-request-id']).toBe('qa-req-0001');
    expect(response.body.request_id).toBe('qa-req-0001');
  });
});

describe('GET /api/v1/me — данные', () => {
  it('первый вход: is_new=true, подписки нет, бесплатные квоты', async () => {
    const response = await request(ctx.app.getHttpServer())
      .get('/api/v1/me')
      .set(INIT_DATA_HEADER, validInitData())
      .expect(200);

    const me = response.body as Me;

    expect(me.user_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(me.is_new).toBe(true);
    expect(me.has_profile).toBe(false);
    expect(me.has_chart).toBe(false);
    expect(me.onboarding_step).toBe('birth_date');
    expect(me.display_name).toBe('Тест Тестов');
    expect(me.subscription).toMatchObject({ plan: 'none', is_active: false, expires_at: null });
    expect(me.quotas.map((quota) => quota.code).sort()).toEqual([
      'ask_daily',
      'compat_month',
      'forecast_daily',
      'report_month',
    ]);

    const quotas = new Map(me.quotas.map((quota) => [quota.code, quota]));
    expect(quotas.get('ask_daily')).toMatchObject({ limit: 1, used: 0 });
    expect(quotas.get('forecast_daily')).toMatchObject({ limit: 1, used: 0 });
    expect(quotas.get('compat_month')).toMatchObject({ limit: 0, used: 0 });
    expect(quotas.get('report_month')).toMatchObject({ limit: 0, used: 0 });
  });

  it('повторный вход: is_new=false, user_id стабилен', async () => {
    const first = await request(ctx.app.getHttpServer())
      .get('/api/v1/me')
      .set(INIT_DATA_HEADER, validInitData())
      .expect(200);
    const second = await request(ctx.app.getHttpServer())
      .get('/api/v1/me')
      .set(INIT_DATA_HEADER, validInitData())
      .expect(200);

    expect(second.body.is_new).toBe(false);
    expect(second.body.user_id).toBe(first.body.user_id);
    // Внутренний UUID не равен telegram_id и не выводится из него без перца
    expect(second.body.user_id).toBe(
      userIdFromTelegramId(BigInt(FICTIONAL_USER.id), TEST_PEPPER),
    );
  });

  it('действующая подписка даёт полные квоты', async () => {
    const userId = userIdFromTelegramId(BigInt(FICTIONAL_USER.id), TEST_PEPPER);
    await ctx.db.query(
      `INSERT INTO subscriptions (user_id, plan, status, expires_at)
       VALUES ($1, 'month', 'active', now() + interval '20 days')`,
      [userId],
    );

    const response = await request(ctx.app.getHttpServer())
      .get('/api/v1/me')
      .set(INIT_DATA_HEADER, validInitData())
      .expect(200);

    const me = response.body as Me;
    expect(me.subscription).toMatchObject({ plan: 'month', is_active: true });
    expect(me.subscription.expires_at).not.toBeNull();

    const quotas = new Map(me.quotas.map((quota) => [quota.code, quota]));
    expect(quotas.get('forecast_daily')?.limit).toBe(-1);
    expect(quotas.get('ask_daily')?.limit).toBe(5);
    expect(quotas.get('compat_month')?.limit).toBe(1);
  });

  it('истёкшая подписка не даёт доступа, но видна в ответе', async () => {
    const userId = userIdFromTelegramId(BigInt(FICTIONAL_USER.id), TEST_PEPPER);
    await ctx.db.query(
      `INSERT INTO subscriptions (user_id, plan, status, expires_at)
       VALUES ($1, 'week', 'active', now() - interval '1 hour')`,
      [userId],
    );

    const response = await request(ctx.app.getHttpServer())
      .get('/api/v1/me')
      .set(INIT_DATA_HEADER, validInitData())
      .expect(200);

    const me = response.body as Me;
    expect(me.subscription).toMatchObject({ plan: 'week', is_active: false });
    expect(me.quotas.find((quota) => quota.code === 'ask_daily')?.limit).toBe(1);
  });

  it('купленный разово разбор снимает лимит report_month', async () => {
    const userId = userIdFromTelegramId(BigInt(FICTIONAL_USER.id), TEST_PEPPER);
    await ctx.db.query(
      `INSERT INTO entitlements (user_id, kind, status) VALUES ($1, 'report', 'active')`,
      [userId],
    );

    const response = await request(ctx.app.getHttpServer())
      .get('/api/v1/me')
      .set(INIT_DATA_HEADER, validInitData())
      .expect(200);

    const me = response.body as Me;
    expect(me.quotas.find((quota) => quota.code === 'report_month')?.limit).toBe(-1);
    // Подписка при этом не появляется
    expect(me.subscription.is_active).toBe(false);
  });

  it('отдаёт израсходованные квоты за текущий период', async () => {
    const userId = userIdFromTelegramId(BigInt(FICTIONAL_USER.id), TEST_PEPPER);
    await ctx.db.query(
      `INSERT INTO quotas (user_id, code, period_key, used, reset_at)
       VALUES ($1, 'ask_daily', $2, 1, now() + interval '1 day')`,
      [userId, todayKey()],
    );

    const response = await request(ctx.app.getHttpServer())
      .get('/api/v1/me')
      .set(INIT_DATA_HEADER, validInitData())
      .expect(200);

    const askDaily = (response.body as Me).quotas.find((quota) => quota.code === 'ask_daily');
    expect(askDaily).toMatchObject({ used: 1, limit: 1 });
  });

  it('профиль и карта отражаются в has_profile / has_chart / onboarding_step', async () => {
    const userId = userIdFromTelegramId(BigInt(FICTIONAL_USER.id), TEST_PEPPER);
    await ctx.db.query(`INSERT INTO users (id, telegram_id) VALUES ($1, $2)`, [
      userId,
      FICTIONAL_USER.id,
    ]);
    await ctx.db.query(
      `INSERT INTO profiles (user_id, birth_date, birth_time, time_accuracy, place_name,
                             place_country, place_lat, place_lon, place_tz, consent_at)
       VALUES ($1, '1990-01-01', null, 'unknown', 'Тестоград', 'RU', 55.75, 37.61,
               'Europe/Moscow', now())`,
      [userId],
    );
    await ctx.db.query(
      `INSERT INTO charts (user_id, input_hash, data, engine_version, time_known)
       VALUES ($1, 'test-hash', '{}'::jsonb, '1.0.0', false)`,
      [userId],
    );

    const response = await request(ctx.app.getHttpServer())
      .get('/api/v1/me')
      .set(INIT_DATA_HEADER, validInitData())
      .expect(200);

    expect(response.body).toMatchObject({
      has_profile: true,
      has_chart: true,
      is_new: false,
    });
    // В profiles.onboarding_step по умолчанию 'done'
    expect(response.body.onboarding_step).toBe('done');
  });
});
