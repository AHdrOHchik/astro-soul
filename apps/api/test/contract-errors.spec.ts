import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { INIT_DATA_HEADER } from '../src/modules/auth/init-data';
import { createTestContext, truncateAll, type TestContext } from './test-app';
import { signInitData } from './init-data-fixture';
import { FICTIONAL_USER, TEST_BOT_TOKEN, TEST_PEPPER } from './test-env';
import { userIdFromTelegramId } from '../src/modules/users/pseudonym';
import { makeFakeAstro } from './fake-astro';

/** Контракт 1.2.1: коды/статусы, `field_errors` и русские тексты. */

let ctx: TestContext;

function initDataFor(user: Record<string, unknown> = FICTIONAL_USER): string {
  return signInitData({ botToken: TEST_BOT_TOKEN, user });
}

const VALID = {
  birth_date: '1994-05-17',
  birth_time: '14:20',
  time_precision: 'exact',
  birth_place: { name: 'Москва', country: 'RU', lat: 55.7558, lon: 37.6173, tz: 'Europe/Moscow' },
  consent: { accepted: true, version: '2026-11-10' },
};

beforeAll(async () => {
  ctx = await createTestContext({ astro: makeFakeAstro() });
});

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  await truncateAll(ctx.db);
});

describe('неизвестный маршрут', () => {
  it('отдаёт Problem на русском, а не текст фреймворка', async () => {
    const response = await request(ctx.app.getHttpServer())
      .post('/api/v1/geo/unknown-route')
      .set(INIT_DATA_HEADER, initDataFor())
      .expect(404);

    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(response.body).toMatchObject({ code: 'NOT_FOUND' });
    expect(response.body.message).toBe('Такой страницы нет. Обнови приложение.');
    expect(response.body.message).not.toContain('Cannot');
  });

  it('несуществующий метод на существующем пути — тоже NOT_FOUND 404', async () => {
    const response = await request(ctx.app.getHttpServer())
      .put('/api/v1/me')
      .set(INIT_DATA_HEADER, initDataFor())
      .expect(404);

    expect(response.body.code).toBe('NOT_FOUND');
    expect(response.body.message).toBe('Такой страницы нет. Обнови приложение.');
  });
});

describe('POST /charts — валидация', () => {
  it('без согласия → 422 и field_errors по consent', async () => {
    const { consent: _consent, ...withoutConsent } = VALID;

    const response = await request(ctx.app.getHttpServer())
      .post('/api/v1/charts')
      .set(INIT_DATA_HEADER, initDataFor())
      .send(withoutConsent)
      .expect(422);

    expect(response.body.code).toBe('VALIDATION_FAILED');
    expect(response.body.details.field_errors).toContainEqual({
      field: 'consent',
      message: expect.any(String) as string,
    });
  });

  it('согласие accepted: false → 422', async () => {
    const response = await request(ctx.app.getHttpServer())
      .post('/api/v1/charts')
      .set(INIT_DATA_HEADER, initDataFor())
      .send({ ...VALID, consent: { accepted: false, version: '2026-11-10' } })
      .expect(422);

    expect(response.body.details.field_errors).toContainEqual({
      field: 'consent',
      message: expect.any(String) as string,
    });
  });

  it('дата в будущем → 422 с понятным текстом', async () => {
    const nextYear = new Date().getUTCFullYear() + 1;
    const response = await request(ctx.app.getHttpServer())
      .post('/api/v1/charts')
      .set(INIT_DATA_HEADER, initDataFor())
      .send({ ...VALID, birth_date: `${nextYear}-01-01` })
      .expect(422);

    expect(response.body.details.field_errors).toEqual([
      { field: 'birth_date', message: 'Дата рождения не может быть в будущем' },
    ]);
  });

  it('раньше 1900 года → 422', async () => {
    const response = await request(ctx.app.getHttpServer())
      .post('/api/v1/charts')
      .set(INIT_DATA_HEADER, initDataFor())
      .send({ ...VALID, birth_date: '1899-12-31' })
      .expect(422);

    expect(response.body.details.field_errors[0].field).toBe('birth_date');
    expect(response.body.details.field_errors[0].message).toContain('1900');
  });

  it('моложе 18 лет → 422', async () => {
    const year = new Date().getUTCFullYear() - 10;
    const response = await request(ctx.app.getHttpServer())
      .post('/api/v1/charts')
      .set(INIT_DATA_HEADER, initDataFor())
      .send({ ...VALID, birth_date: `${year}-01-01` })
      .expect(422);

    expect(response.body.details.field_errors).toEqual([
      { field: 'birth_date', message: 'Сервис доступен с 18 лет' },
    ]);
  });

  it('time_precision=unknown со временем → 422 по birth_time', async () => {
    const response = await request(ctx.app.getHttpServer())
      .post('/api/v1/charts')
      .set(INIT_DATA_HEADER, initDataFor())
      .send({ ...VALID, time_precision: 'unknown' })
      .expect(422);

    expect(response.body.details.field_errors[0].field).toBe('birth_time');
  });

  it('неизвестный часовой пояс → 422 по birth_place', async () => {
    const response = await request(ctx.app.getHttpServer())
      .post('/api/v1/charts')
      .set(INIT_DATA_HEADER, initDataFor())
      .send({ ...VALID, birth_place: { ...VALID.birth_place, tz: 'Mars/Olympus' } })
      .expect(422);

    expect(response.body.details.field_errors[0].field).toBe('birth_place');
  });

  it('несколько смысловых ошибок сразу, без дублей по полю', async () => {
    const response = await request(ctx.app.getHttpServer())
      .post('/api/v1/charts')
      .set(INIT_DATA_HEADER, initDataFor())
      .send({ ...VALID, birth_date: '1899-01-01', birth_time: null })
      .expect(422);

    const fields = (response.body.details.field_errors as { field: string }[]).map((e) => e.field);
    expect(new Set(fields).size).toBe(fields.length);
    expect(fields).toEqual(['birth_date', 'birth_time']);
  });

  it('ошибки формы (страна, координаты, согласие) тоже попадают в field_errors', async () => {
    const response = await request(ctx.app.getHttpServer())
      .post('/api/v1/charts')
      .set(INIT_DATA_HEADER, initDataFor())
      .send({
        ...VALID,
        birth_place: { ...VALID.birth_place, country: 'ru', lat: 200 },
        consent: { accepted: false, version: '2026-11-10' },
      })
      .expect(422);

    const fields = (response.body.details.field_errors as { field: string }[]).map((e) => e.field);
    expect(fields).toEqual(expect.arrayContaining(['birth_place', 'consent']));
  });
});

describe('POST /charts — успешный сценарий', () => {
  it('сохраняет согласие и точность времени, возвращает time_precision', async () => {
    const response = await request(ctx.app.getHttpServer())
      .post('/api/v1/charts')
      .set(INIT_DATA_HEADER, initDataFor())
      .send(VALID)
      .expect(201);

    expect(response.body.chart.birth.time_precision).toBe('exact');
    expect(response.body.wheel_url).toMatch(/\/api\/v1\/charts\/[0-9a-f-]{36}\/wheel\.svg\?sig=/);

    const userId = userIdFromTelegramId(BigInt(FICTIONAL_USER.id), TEST_PEPPER);
    const profile = await ctx.db.queryOne<{
      time_mode: string;
      consent_version: string;
      consent_at: Date | null;
      onboarding_step: string;
    }>(
      `SELECT time_mode::text AS time_mode, consent_version, consent_at, onboarding_step::text AS onboarding_step
         FROM profiles WHERE user_id = $1`,
      [userId],
    );

    expect(profile).toMatchObject({
      time_mode: 'exact',
      consent_version: '2026-11-10',
      onboarding_step: 'done',
    });
    expect(profile?.consent_at).not.toBeNull();
  });

  it('time_precision=unknown: без времени, дома и ASC не считаются', async () => {
    const response = await request(ctx.app.getHttpServer())
      .post('/api/v1/charts')
      .set(INIT_DATA_HEADER, initDataFor())
      .send({ ...VALID, birth_time: null, time_precision: 'unknown' })
      .expect(201);

    expect(response.body.chart.birth.time_precision).toBe('unknown');
  });
});
