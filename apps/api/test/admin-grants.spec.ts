import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { INIT_DATA_HEADER } from '../src/modules/auth/init-data';
import { UsersRepository } from '../src/modules/users/users.repository';
import { parseAdminCodeCreate, parseAdminGrantCreate } from '../src/modules/grants/admin.dto';
import { createTestContext, truncateAll, type TestContext } from './test-app';
import { signInitData } from './init-data-fixture';
import { FICTIONAL_USER, TEST_BOT_TOKEN } from './test-env';

/**
 * Админские маршруты выдачи доступа (итерация 39, контракт 1.6.14).
 *
 * Проверяется то, что нельзя проверить «на глаз»: парсеры админского тела
 * (чистые функции, без БД) и то, что маршрут закрыт для не-админа. Сама выдача
 * прав проверена в `grants.spec.ts` на пользовательских маршрутах — здесь важна
 * только дверь.
 */

const ADMIN_TG_ID = '777000999';

let ctx: TestContext;
let users: UsersRepository;

const ADMIN = { ...FICTIONAL_USER, id: Number(ADMIN_TG_ID), username: 'admin_user' };

function initData(user: Record<string, unknown> = FICTIONAL_USER): string {
  return signInitData({ botToken: TEST_BOT_TOKEN, user });
}

beforeAll(async () => {
  // Админ определяется по `ADMIN_TG_ID`: в тестах он вымышленный.
  ctx = await createTestContext({ env: { ADMIN_TG_ID } });
  users = ctx.app.get(UsersRepository);
});

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  await truncateAll(ctx.db);
});

describe('parseAdminGrantCreate', () => {
  it('все дни для «всё включено» и никаких для одноразового', () => {
    expect(
      parseAdminGrantCreate({ user_id: 'u1', kind: 'all_access', days: 30 }),
    ).toMatchObject({ kind: 'all_access', days: 30, action: 'issue' });

    expect(parseAdminGrantCreate({ user_id: 'u1', kind: 'single_report' })).toMatchObject({
      days: null,
      action: 'issue',
    });
  });

  it('отзыв требует grant_id', () => {
    expect(
      parseAdminGrantCreate({ user_id: 'u1', kind: 'all_access', action: 'revoke', grant_id: 'g1' }),
    ).toMatchObject({ action: 'revoke', grant_id: 'g1', days: null });

    expect(() =>
      parseAdminGrantCreate({ user_id: 'u1', kind: 'all_access', action: 'revoke' }),
    ).toThrow(/Обязательное поле/u);
  });

  it.each([
    [{ user_id: 'u1', kind: 'all_access', days: 0 }, 'days'],
    [{ user_id: 'u1', kind: 'all_access', days: 3651 }, 'days'],
    [{ user_id: 'u1', kind: 'all_access', days: 1.5 }, 'days'],
    [{ user_id: 'u1', kind: 'all_access' }, 'days'],
    [{ user_id: 'u1', kind: 'single_report', days: 30 }, 'days'],
    [{ user_id: 'u1', kind: 'month' }, 'kind'],
    [{ kind: 'single_report' }, 'user_id'],
    [{}, 'kind'],
  ])('%o — 422 с полем %s', (body, field) => {
    try {
      parseAdminGrantCreate(body);
      throw new Error('ожидали ошибку');
    } catch (error) {
      const details = (error as { details?: { field_errors?: { field: string }[] } }).details;
      const fields = details?.field_errors?.map((item) => item.field) ?? [];
      // «нет user_id» ловится первым: там же и остальные поля.
      // Парсер останавливается на первой проблеме: `{}` ругается на `kind`
      // (порядок чтения), поэтому проверяем «поле названо», а не «все поля».
      expect(fields).toContain(field);
    }
  });

  it('дни строкой не считаются числом молча', () => {
    // '30' → 30 допустимо (форма может прислать строку), 'тридцать' — нет.
    expect(parseAdminGrantCreate({ user_id: 'u1', kind: 'all_access', days: '30' }).days).toBe(30);
    expect(() =>
      parseAdminGrantCreate({ user_id: 'u1', kind: 'all_access', days: 'тридцать' }),
    ).toThrow(/дней/u);
  });
});

describe('parseAdminCodeCreate', () => {
  it('счётчик активаций обязателен', () => {
    expect(parseAdminCodeCreate({ kind: 'single_report', max_activations: 5 })).toMatchObject({
      kind: 'single_report',
      days: null,
      maxActivations: 5,
      partnerName: null,
      expiresAt: null,
    });

    expect(() => parseAdminCodeCreate({ kind: 'single_report' })).toThrow(/Целое число/u);
  });

  it('«всё включено» без дней не создаётся', () => {
    expect(() => parseAdminCodeCreate({ kind: 'all_access', max_activations: 1 })).toThrow(
      /дней/u,
    );
  });

  it('срок принимает ISO и отвергает мусор', () => {
    const parsed = parseAdminCodeCreate({
      kind: 'single_report',
      max_activations: 1,
      expires_at: '2026-12-31T00:00:00.000Z',
    });
    expect(parsed.expiresAt?.toISOString()).toBe('2026-12-31T00:00:00.000Z');

    expect(() =>
      parseAdminCodeCreate({ kind: 'single_report', max_activations: 1, expires_at: 'завтра' }),
    ).toThrow(/ISO/u);
  });

  it('пустое имя партнёра — это «нет партнёра», а не пустая строка', () => {
    expect(
      parseAdminCodeCreate({ kind: 'single_report', max_activations: 1, partner_name: '' })
        .partnerName,
    ).toBeNull();
  });
});

describe('доступ к админским маршрутам', () => {
  it('обычный пользователь получает 403 на всех четырёх', async () => {
    await users.ensureUser({ telegramUserId: BigInt(FICTIONAL_USER.id), languageCode: 'ru' });

    for (const [method, path] of [
      ['get', '/api/v1/admin/grants'],
      ['post', '/api/v1/admin/grants'],
      ['get', '/api/v1/admin/codes'],
      ['post', '/api/v1/admin/codes'],
    ] as const) {
      const call = method === 'get' ? request(ctx.app.getHttpServer()).get(path) : request(ctx.app.getHttpServer()).post(path).send({});

      await call.set(INIT_DATA_HEADER, initData()).expect(403);
    }
  });

  it('админ создаёт код и видит его в списке', async () => {
    await users.ensureUser({ telegramUserId: BigInt(FICTIONAL_USER.id), languageCode: 'ru' });

    const created = await request(ctx.app.getHttpServer())
      .post('/api/v1/admin/codes')
      .set(INIT_DATA_HEADER, initData(ADMIN))
      .send({ kind: 'single_compat', max_activations: 3, partner_name: 'Городской паблик' })
      .expect(201);

    expect(created.body.code).toMatch(/^[A-Z0-9]{8}$/u);
    expect(created.body.is_active).toBe(true);

    const list = await request(ctx.app.getHttpServer())
      .get('/api/v1/admin/codes')
      .set(INIT_DATA_HEADER, initData(ADMIN))
      .expect(200);

    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0]).toMatchObject({
      code: created.body.code,
      kind: 'single_compat',
      max_activations: 3,
      activations: 0,
      partner_name: 'Городской паблик',
    });
  });

  it('админ выдаёт право и отзывает его; чужое не отзывается', async () => {
    const owner = await users.ensureUser({
      telegramUserId: BigInt(FICTIONAL_USER.id),
      languageCode: 'ru',
    });
    const stranger = await users.ensureUser({ telegramUserId: 777_000_444n, languageCode: 'ru' });

    const issued = await request(ctx.app.getHttpServer())
      .post('/api/v1/admin/grants')
      .set(INIT_DATA_HEADER, initData(ADMIN))
      .send({ user_id: owner.userId, kind: 'all_access', days: 10 })
      .expect(200);

    expect(issued.body).toMatchObject({ kind: 'all_access', source: 'admin' });
    expect(issued.body.grant_id).toBeTypeOf('string');

    // Чужой `user_id` с этим `grant_id` — 404, а не «отозвали на всякий случай».
    await request(ctx.app.getHttpServer())
      .post('/api/v1/admin/grants')
      .set(INIT_DATA_HEADER, initData(ADMIN))
      .send({
        user_id: stranger.userId,
        kind: 'all_access',
        action: 'revoke',
        grant_id: issued.body.grant_id,
      })
      .expect(404);

    await request(ctx.app.getHttpServer())
      .post('/api/v1/admin/grants')
      .set(INIT_DATA_HEADER, initData(ADMIN))
      .send({
        user_id: owner.userId,
        kind: 'all_access',
        action: 'revoke',
        grant_id: issued.body.grant_id,
      })
      .expect(200);

    const list = await request(ctx.app.getHttpServer())
      .get(`/api/v1/admin/grants?user_id=${owner.userId}`)
      .set(INIT_DATA_HEADER, initData(ADMIN))
      .expect(200);

    expect(list.body.items[0]).toMatchObject({ id: issued.body.grant_id, revoked: true });
  });
});
