import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Me, Notifications } from '@astro-soul/shared';
import { INIT_DATA_HEADER } from '../src/modules/auth/init-data';
import { createTestContext, truncateAll, type TestContext } from './test-app';
import { signInitData } from './init-data-fixture';
import { FICTIONAL_USER, TEST_BOT_TOKEN } from './test-env';

/**
 * Согласия на уведомления (итерация 36, задача 4) и заготовка журнала пушей.
 *
 * Самого пуша в этой итерации нет — проверяется хранение согласия: значение
 * переживает запрос, отдаётся в `Me.notifications`, требует явного boolean и
 * исчезает вместе с аккаунтом. Отдельно проверяется, что `push_log` не даёт
 * записать второй пуш за те же местные сутки: на этом держится идемпотентность
 * будущего джоба.
 */

let ctx: TestContext;

function initData(): string {
  return signInitData({ botToken: TEST_BOT_TOKEN, user: FICTIONAL_USER });
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

async function getMe(): Promise<Me> {
  const response = await request(ctx.app.getHttpServer())
    .get('/api/v1/me')
    .set(INIT_DATA_HEADER, initData())
    .expect(200);

  return response.body as Me;
}

async function postNotifications(body: unknown): Promise<request.Response> {
  return request(ctx.app.getHttpServer())
    .post('/api/v1/me/notifications')
    .set(INIT_DATA_HEADER, initData())
    .send(body as object)
    .expect((response) => {
      if (response.status !== 200 && response.status !== 422) {
        throw new Error(`неожиданный код ${String(response.status)}`);
      }
    });
}

describe('Me.notifications', () => {
  it('у нового пользователя пуш включён — умолчание схемы', async () => {
    const me = await getMe();

    expect(me.notifications).toEqual({ daily_forecast: true });
    // Поле добавочное: в `required` его нет, старый клиент его просто не читает.
    expect(me.user_id).toBeTruthy();
  });

  it('POST сохраняет отказ и он виден в GET /me', async () => {
    await getMe();

    const response = await postNotifications({ daily_forecast: false });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ daily_forecast: false });

    expect((await getMe()).notifications).toEqual({ daily_forecast: false });
  });

  it('включить обратно — тоже работает', async () => {
    await getMe();
    await postNotifications({ daily_forecast: false });

    const response = await postNotifications({ daily_forecast: true });
    expect(response.body).toEqual({ daily_forecast: true });
    expect((await getMe()).notifications).toEqual({ daily_forecast: true });
  });

  it('ответ совпадает по форме с Me.notifications', async () => {
    await getMe();

    const response = await postNotifications({ daily_forecast: false });
    const fromMe = await getMe();

    expect(Object.keys(response.body as Notifications).sort()).toEqual(
      Object.keys(fromMe.notifications ?? {}).sort(),
    );
  });

  it('без поля — 422 с field_errors по daily_forecast', async () => {
    await getMe();

    const response = await postNotifications({});
    expect(response.status).toBe(422);
    expect(response.body).toMatchObject({
      code: 'VALIDATION_FAILED',
      details: { field_errors: [{ field: 'daily_forecast' }] },
    });
  });

  it('строка вместо boolean — 422: «false» из формы не равно false', async () => {
    await getMe();

    const response = await postNotifications({ daily_forecast: 'false' });
    expect(response.status).toBe(422);
    expect((await getMe()).notifications).toEqual({ daily_forecast: true });
  });

  it('лишний ключ — 422 с именем ключа, а не молчаливое «сохранено»', async () => {
    await getMe();

    const response = await postNotifications({ daily_forecast: false, daily_forecats: true });
    expect(response.status).toBe(422);
    expect(response.body).toMatchObject({ details: { field_errors: [{ field: 'daily_forecats' }] } });
    // И состояние не изменилось: отказ целиком, а не «половина применилась».
    expect((await getMe()).notifications).toEqual({ daily_forecast: true });
  });

  it('пустое тело — 422, а не 500', async () => {
    await getMe();

    const response = await request(ctx.app.getHttpServer())
      .post('/api/v1/me/notifications')
      .set(INIT_DATA_HEADER, initData())
      .set('Content-Type', 'application/json')
      .send('{}')
      .expect(422);

    expect(response.body).toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('без initData — 401', async () => {
    await request(ctx.app.getHttpServer())
      .post('/api/v1/me/notifications')
      .send({ daily_forecast: false })
      .expect(401);
  });

  it('DELETE /me стирает согласие вместе с аккаунтом', async () => {
    await getMe();
    await postNotifications({ daily_forecast: false });

    await request(ctx.app.getHttpServer()).delete('/api/v1/me').set(INIT_DATA_HEADER, initData()).expect(204);

    expect((await getMe()).notifications).toEqual({ daily_forecast: true });
  });
});

describe('push_log — заготовка журнала (миграция 0031)', () => {
  async function insertPush(userId: string, localDate: string, kind = 'daily_forecast'): Promise<void> {
    await ctx.db.query(
      `INSERT INTO push_log (user_id, local_date, kind) VALUES ($1, $2::date, $3)`,
      [userId, localDate, kind],
    );
  }

  it('второй пуш за те же местные сутки отклоняется базой', async () => {
    const me = await getMe();
    await insertPush(me.user_id, '2026-11-20');

    await expect(insertPush(me.user_id, '2026-11-20')).rejects.toThrow(/push_log_user_date_kind_key/u);
  });

  it('другой вид пуша и другие сутки — можно', async () => {
    const me = await getMe();
    await insertPush(me.user_id, '2026-11-20');

    await insertPush(me.user_id, '2026-11-20', 'report_reminder');
    await insertPush(me.user_id, '2026-11-21');

    const row = await ctx.db.queryOne<{ total: number }>(
      `SELECT count(*)::int AS total FROM push_log WHERE user_id = $1`,
      [me.user_id],
    );
    expect(row?.total).toBe(3);
  });

  it('журнал удаляется вместе с аккаунтом', async () => {
    const me = await getMe();
    await insertPush(me.user_id, '2026-11-20');

    await request(ctx.app.getHttpServer()).delete('/api/v1/me').set(INIT_DATA_HEADER, initData()).expect(204);

    const row = await ctx.db.queryOne<{ total: number }>(`SELECT count(*)::int AS total FROM push_log`);
    expect(row?.total).toBe(0);
  });
});
