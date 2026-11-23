import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { Me } from '@astro-soul/shared';
import { INIT_DATA_HEADER } from '../src/modules/auth/init-data';
import { UsersRepository } from '../src/modules/users/users.repository';
import { EntitlementsService } from '../src/modules/entitlements/entitlements.service';
import { GrantsService } from '../src/modules/grants/grants.service';
import { AccessCodesService } from '../src/modules/grants/access-codes.service';
import { ReferralsService } from '../src/modules/grants/referrals.service';
import { BonusBudgetService } from '../src/modules/grants/bonus-budget.service';
import { AccessService } from '../src/modules/entitlements/access.service';
import { createTestContext, truncateAll, type TestContext } from './test-app';
import { signInitData } from './init-data-fixture';
import { FICTIONAL_USER, TEST_BOT_TOKEN } from './test-env';

/**
 * Бесплатный доступ по праву (итерация 39, контракт 1.6.14).
 *
 * Проверяется то, из-за чего этот механизм существует, а не «маршрут отвечает
 * 200»:
 *   • **грант не подписка** — после активации кода в `subscriptions` пусто, а
 *     доступ при этом есть. Иначе `subscription_cancel_no_charge_id_24h`
 *     начнёт кричать о том, чего не было;
 *   • **срок начинается с карты** — код, активированный до онбординга, не
 *     сжигает дни; после первой карты срок идёт;
 *   • **повторная выдача продлевает** — уникальный индекс допускает одно
 *     неотозванное право `all_access`, поэтому второй код добавляет дни, а не
 *     создаёт вторую строку;
 *   • **атомарность** — исчерпанный код и 51-е место основателя отказывают
 *     даже при гонке (проверяется счётчиком и уникальностью в схеме);
 *   • **бюджет** — исчерпанный бюджет отказывает в новых грантах и **не**
 *     отзывает действующие.
 */

let ctx: TestContext;
let users: UsersRepository;
let entitlements: EntitlementsService;
let grants: GrantsService;
let codes: AccessCodesService;
let referrals: ReferralsService;

const OTHER_USER = { ...FICTIONAL_USER, id: 777_000_222, username: 'other_user' };

function initData(user: Record<string, unknown> = FICTIONAL_USER): string {
  return signInitData({ botToken: TEST_BOT_TOKEN, user });
}

function userIdOf(user: Record<string, unknown>): string {
  return users.userIdFor(BigInt(Number(user['id'])));
}

beforeAll(async () => {
  ctx = await createTestContext();
  users = ctx.app.get(UsersRepository);
  entitlements = ctx.app.get(EntitlementsService);
  grants = ctx.app.get(GrantsService);
  codes = ctx.app.get(AccessCodesService);
  referrals = ctx.app.get(ReferralsService);
});

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  await truncateAll(ctx.db);
});

/** Пользователь в базе (первый вход), без карты. */
async function ensureUser(user: Record<string, unknown> = FICTIONAL_USER): Promise<string> {
  const result = await users.ensureUser({
    telegramUserId: BigInt(Number(user['id'])),
    languageCode: 'ru',
  });

  return result.userId;
}

/** Карта: минимальная валидная строка для проверки «карта есть». */
async function giveChart(userId: string): Promise<void> {
  await ctx.db.query(
    `INSERT INTO charts (user_id, input_hash, data, engine_version, time_known)
     VALUES ($1, $2, '{"chart": {}}'::jsonb, 'test', true)`,
    [userId, `hash-${userId.slice(0, 8)}`],
  );
}

async function activate(
  user: Record<string, unknown>,
  code: string,
  expectedStatus = 200,
): Promise<request.Response> {
  const response = await request(ctx.app.getHttpServer())
    .post('/api/v1/me/activate-code')
    .set(INIT_DATA_HEADER, initData(user))
    .send({ code });

  if (response.status !== expectedStatus) {
    throw new Error(
      `активация «${code}»: ждали ${String(expectedStatus)}, получили ${String(response.status)} — ${JSON.stringify(response.body)}`,
    );
  }

  return response;
}

async function me(user: Record<string, unknown> = FICTIONAL_USER): Promise<Me> {
  const response = await request(ctx.app.getHttpServer())
    .get('/api/v1/me')
    .set(INIT_DATA_HEADER, initData(user))
    .expect(200);

  return response.body as Me;
}

describe('код доступа: активация', () => {
  it('выдаёт «всё включено» и не создаёт подписку', async () => {
    const userId = await ensureUser();
    await giveChart(userId);

    const code = await codes.create({
      kind: 'all_access',
      days: 30,
      maxActivations: 5,
      partnerName: 'Тестовый партнёр',
    });

    const response = await activate(FICTIONAL_USER, code.code, 200);

    expect(response.body.entitlements.all_access_until).toBeTypeOf('string');
    expect(response.body.entitlements.source).toBe('partner');
    expect(response.body.entitlements.is_active).toBe(true);
    expect(response.body.entitlements.full_forecast).toBe(true);

    // Главное: доступ есть, а подписки нет.
    const subscriptions = await ctx.db.query<{ total: string }>(
      `SELECT count(*)::text AS total FROM subscriptions`,
    );
    expect(subscriptions[0]?.total).toBe('0');

    const grants = await ctx.db.query<{ kind: string; source: string; days: number }>(
      `SELECT kind, source, days FROM grants WHERE user_id = $1`,
      [userId],
    );
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({ kind: 'all_access', source: 'partner', days: 30 });
  });

  it('без карты право ждёт: срок не начался, дни не сгорают', async () => {
    const userId = await ensureUser();

    const code = await codes.create({ kind: 'all_access', days: 30, maxActivations: 1 });
    const response = await activate(FICTIONAL_USER, code.code, 200);

    expect(response.body.entitlements.all_access_until).toBeNull();
    expect(response.body.entitlements.single_reports).toBe(0);

    const row = await ctx.db.queryOne<{ starts_at: Date | null; expires_at: Date | null }>(
      `SELECT starts_at, expires_at FROM grants WHERE user_id = $1`,
      [userId],
    );
    expect(row?.starts_at).toBeNull();
    expect(row?.expires_at).toBeNull();

    // Карта построена — право стартует, и срок считается от этого момента.
    await giveChart(userId);
    const started = await grants.startPendingFor(userId);
    expect(started).toBe(1);

    const after = await ctx.db.queryOne<{ starts_at: Date | null; expires_at: Date | null }>(
      `SELECT starts_at, expires_at FROM grants WHERE user_id = $1`,
      [userId],
    );
    expect(after?.starts_at).not.toBeNull();
    expect(after?.expires_at).not.toBeNull();

    const days =
      (after!.expires_at!.getTime() - after!.starts_at!.getTime()) / (24 * 60 * 60 * 1000);
    expect(Math.round(days)).toBe(30);
  });

  it('второй код продлевает срок, а не создаёт второе право', async () => {
    const userId = await ensureUser();
    await giveChart(userId);

    const first = await codes.create({ kind: 'all_access', days: 14, maxActivations: 5 });
    const second = await codes.create({ kind: 'all_access', days: 7, maxActivations: 5 });

    const firstResponse = await activate(FICTIONAL_USER, first.code, 200);
    const untilFirst = new Date(firstResponse.body.entitlements.all_access_until as string);

    const secondResponse = await activate(FICTIONAL_USER, second.code, 200);
    const untilSecond = new Date(secondResponse.body.entitlements.all_access_until as string);

    const addedDays = (untilSecond.getTime() - untilFirst.getTime()) / (24 * 60 * 60 * 1000);
    expect(Math.round(addedDays)).toBe(7);

    const rows = await ctx.db.query<{ total: string; days: number }>(
      `SELECT count(*)::text AS total, max(days)::int AS days FROM grants WHERE user_id = $1`,
      [userId],
    );
    expect(rows[0]?.total).toBe('1');
    // Дни суммируются: 14 + 7.
    expect(rows[0]?.days).toBe(21);
  });

  it('повторная активация того же кода — 409 already_activated', async () => {
    await ensureUser();
    const code = await codes.create({ kind: 'single_report', maxActivations: 5 });

    await activate(FICTIONAL_USER, code.code, 200);
    const second = await activate(FICTIONAL_USER, code.code, 409);

    expect(second.body.details.reason).toBe('already_activated');
  });

  it('исчерпанный код — 409 code_exhausted', async () => {
    await ensureUser();
    const code = await codes.create({ kind: 'single_report', maxActivations: 1 });

    await activate(FICTIONAL_USER, code.code, 200);
    // Другой человек претендует на ту же единственную активацию.
    const second = await activate(OTHER_USER, code.code, 409);

    expect(second.body.details.reason).toBe('code_exhausted');
  });

  it('просроченный код — 410 code_expired', async () => {
    await ensureUser();
    const code = await codes.create({
      kind: 'single_report',
      maxActivations: 5,
      expiresAt: new Date(Date.now() - 1000),
    });

    const response = await activate(FICTIONAL_USER, code.code, 410);
    expect(response.body.details.reason).toBe('code_expired');
  });

  it('несуществующий код — 404 code_not_found', async () => {
    await ensureUser();
    const response = await activate(FICTIONAL_USER, 'ZZZZZZZZ', 404);
    expect(response.body.details.reason).toBe('code_not_found');
  });

  it('мусор вместо кода — 422 с полем code', async () => {
    await ensureUser();
    const response = await activate(FICTIONAL_USER, 'код!', 422);

    expect(response.body.details.field_errors[0].field).toBe('code');
  });

  it('без initData — 401', async () => {
    await request(ctx.app.getHttpServer())
      .post('/api/v1/me/activate-code')
      .send({ code: 'ABCDEFGH' })
      .expect(401);
  });

  it('код города-партнёра нормализуется: регистр и пробелы не важны', async () => {
    await ensureUser();
    const code = await codes.create({
      kind: 'single_compat',
      maxActivations: 1,
      code: 'ABCDEFGH',
    });

    const response = await activate(FICTIONAL_USER, ' abcd efgh ', 200);
    expect(response.body.entitlements.single_compat).toBe(1);
    expect(code.code).toBe('ABCDEFGH');
  });
});

describe('одноразовые права', () => {
  it('разбор списывает право один раз и открывает доступ к этой карте', async () => {
    const userId = await ensureUser();
    await giveChart(userId);

    const access = ctx.app.get(AccessService);
    const chartId = (
      await ctx.db.queryOne<{ id: string }>(`SELECT id FROM charts WHERE user_id = $1`, [userId])
    )!.id;

    await grants.issue({ userId, kind: 'single_report', source: 'founder' });

    const before = await entitlements.getGrantEntitlements(userId);
    expect(before.singleReports).toBe(1);

    const first = await access.hasAccess(userId, 'report', { chartId, consume: true });
    expect(first).toBe(true);

    // Право израсходовано: на другую карту его уже не хватает.
    const otherChart = await ctx.db.queryOne<{ id: string }>(
      `INSERT INTO charts (user_id, input_hash, data, engine_version, time_known)
       VALUES ($1, $2, '{"chart": {}}'::jsonb, 'test', true) RETURNING id`,
      [userId, `hash-second-${userId.slice(0, 8)}`],
    );
    const second = await access.hasAccess(userId, 'report', {
      chartId: otherChart!.id,
      consume: true,
    });
    expect(second).toBe(false);

    // Расход материализуется в `entitlements` — иначе не открылся бы PDF.
    const rows = await ctx.db.query<{ total: string }>(
      `SELECT count(*)::text AS total FROM entitlements
        WHERE user_id = $1 AND kind = 'report' AND chart_id = $2`,
      [userId, chartId],
    );
    expect(rows[0]?.total).toBe('1');

    const after = await entitlements.getEntitlements(userId);
    expect(after.fullReport).toBe(true);
    expect(after.fullReportChartId).toBe(chartId);
  });

  it('право «всё включено» открывает совместимость без покупки', async () => {
    const userId = await ensureUser();
    await giveChart(userId);
    await grants.issue({ userId, kind: 'all_access', source: 'admin', days: 3 });

    const access = ctx.app.get(AccessService);

    expect(await access.hasAccess(userId, 'compat')).toBe(true);
    expect(await access.hasAccess(userId, 'full_forecast')).toBe(true);
    expect(await access.hasAccess(userId, 'ask')).toBe(true);
    expect(await access.hasAccess(userId, 'solar')).toBe(true);

    const period = await access.accessPeriod(userId);
    expect(period).not.toBeNull();
  });
});

describe('«первые 50»', () => {
  it('51-й получает 409 founders_exhausted', async () => {
    // Занимаем 50 мест напрямую: 50 HTTP-запросов в одном тесте — это 50
    // пушей в лог и секунды ожидания, а проверяется 51-й.
    for (let place = 1; place <= 50; place += 1) {
      const id = `00000000-0000-4000-8000-${String(place).padStart(12, '0')}`;
      await ctx.db.query(
        `INSERT INTO users (id, telegram_id) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`,
        [id, `900000${String(place).padStart(6, '0')}`],
      );
      await ctx.db.query(`INSERT INTO founders (user_id, place) VALUES ($1, $2)`, [id, place]);
    }

    const count = await request(ctx.app.getHttpServer())
      .get('/api/v1/founders/count')
      .expect(200);
    expect(count.body).toEqual({ taken: 50, total: 50 });

    const response = await request(ctx.app.getHttpServer())
      .post('/api/v1/me/founder-claim')
      .set(INIT_DATA_HEADER, initData())
      .expect(409);

    expect(response.body.details.reason).toBe('founders_exhausted');
  });

  it('выдаёт место, разбор и 14 дней; повтор идемпотентен', async () => {
    const userId = await ensureUser();
    await giveChart(userId);

    const first = await request(ctx.app.getHttpServer())
      .post('/api/v1/me/founder-claim')
      .set(INIT_DATA_HEADER, initData())
      .expect(200);

    expect(first.body.founder_place).toBe(1);
    expect(first.body.entitlements.is_founder).toBe(true);
    expect(first.body.entitlements.single_reports).toBe(1);
    expect(first.body.entitlements.all_access_until).toBeTypeOf('string');

    const second = await request(ctx.app.getHttpServer())
      .post('/api/v1/me/founder-claim')
      .set(INIT_DATA_HEADER, initData())
      .expect(200);

    expect(second.body.founder_place).toBe(1);
    // Второй раз ничего не выдаётся: разбор остаётся один.
    expect(second.body.entitlements.single_reports).toBe(1);

    const rows = await ctx.db.query<{ total: string }>(
      `SELECT count(*)::text AS total FROM grants WHERE user_id = $1`,
      [userId],
    );
    expect(rows[0]?.total).toBe('2');
  });

  it('счётчик публичный и без ПДн', async () => {
    const response = await request(ctx.app.getHttpServer())
      .get('/api/v1/founders/count')
      .expect(200);

    expect(Object.keys(response.body).sort()).toEqual(['taken', 'total']);
  });
});

describe('приглашения', () => {
  it('награда только после карты приглашённого и один раз', async () => {
    const referrerId = await ensureUser();
    await giveChart(referrerId);
    const shortId = await referrals.ensureShortId(referrerId);

    const referredId = await ensureUser(OTHER_USER);
    const joined = await referrals.joinByShortId(shortId, referredId);
    expect(joined).toBe('joined');

    // Переход сам по себе денег не стоит: без карты награды нет.
    const beforeChart = await referrals.rewardAfterChart(referredId);
    expect(beforeChart).toMatchObject({ rewarded: false, reason: 'no_chart' });

    await giveChart(referredId);
    const rewarded = await referrals.rewardAfterChart(referredId);
    expect(rewarded).toMatchObject({ rewarded: true, days: 30 });

    const again = await referrals.rewardAfterChart(referredId);
    expect(again.reason).toBe('already_rewarded');

    const rights = await entitlements.getGrantEntitlements(referrerId);
    expect(rights.allAccessUntil).not.toBeNull();
    expect(rights.source).toBe('referral');
  });

  it('себя пригласить нельзя', async () => {
    const userId = await ensureUser();
    const shortId = await referrals.ensureShortId(userId);

    expect(await referrals.joinByShortId(shortId, userId)).toBe('self');
  });

  it('того, у кого уже есть карта, пригласить нельзя', async () => {
    const referrerId = await ensureUser();
    const shortId = await referrals.ensureShortId(referrerId);

    const existingId = await ensureUser(OTHER_USER);
    await giveChart(existingId);

    expect(await referrals.joinByShortId(shortId, existingId)).toBe('existing');
  });

  it('потолок 90 дней из этого источника', async () => {
    const referrerId = await ensureUser();
    await giveChart(referrerId);

    // Три награды по 30 дней — ровно потолок; четвёртая не начисляется.
    for (let index = 0; index < 3; index += 1) {
      await grants.issue({ userId: referrerId, kind: 'all_access', source: 'referral', days: 30 });
    }

    const shortId = await referrals.ensureShortId(referrerId);
    const referredId = await ensureUser(OTHER_USER);
    expect(await referrals.joinByShortId(shortId, referredId)).toBe('joined');
    await giveChart(referredId);

    const fourth = await referrals.rewardAfterChart(referredId);
    expect(fourth).toMatchObject({ rewarded: false, reason: 'cap' });
  });

  it('ссылка содержит только short_id', async () => {
    const userId = await ensureUser();
    const shortId = await referrals.ensureShortId(userId);
    const link = referrals.linkFor(shortId);

    expect(link).toBe(`https://t.me/astro_soul_test_bot?start=ref_${shortId}`);
    expect(link).not.toContain(userId);
    expect(link).not.toContain(String(FICTIONAL_USER.id));
  });
});

describe('бюджет бесплатного доступа', () => {
  it('исчерпанный бюджет отказывает в новом гранте и не трогает выданные', async () => {
    const userId = await ensureUser();
    await giveChart(userId);
    await grants.issue({ userId, kind: 'all_access', source: 'partner', days: 30 });

    // Бюджет 0 ₽: любая новая выдача — отказ. Подменяем состояние через
    // `spyOn`, а не поле класса: бюджет читается сервисом, и подмена на уровне
    // DI — это ровно то, что видит прод.
    const budget = ctx.app.get(BonusBudgetService);
    const spy = vi
      .spyOn(budget, 'state')
      .mockResolvedValue({ spent_rub: 15_000, limit_rub: 15_000, exhausted: true });

    try {
      const code = await codes.create({ kind: 'single_report', maxActivations: 5 });
      const response = await activate(FICTIONAL_USER, code.code, 503);

      expect(response.body.details.reason).toBe('bonus_budget_exhausted');
      // Действующее право продолжает работать.
      const rights = await entitlements.getEntitlements(userId);
      expect(rights.isActive).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('Me.entitlements', () => {
  it('поля грантов есть у обычного пользователя и пусты', async () => {
    const response = await me();

    expect(response.entitlements).toMatchObject({
      all_access_until: null,
      source: null,
      single_reports: 0,
      single_compat: 0,
      is_founder: false,
      founder_place: null,
    });
    expect(response.referral_link).toBeTypeOf('string');
  });
});

describe('удаление аккаунта', () => {
  it('права и приглашения уходят вместе с человеком', async () => {
    const userId = await ensureUser();
    await giveChart(userId);
    await grants.issue({ userId, kind: 'single_report', source: 'founder' });
    await referrals.ensureShortId(userId);

    await request(ctx.app.getHttpServer())
      .delete('/api/v1/me')
      .set(INIT_DATA_HEADER, initData())
      .expect(204);

    const left = await ctx.db.query<{ total: string }>(
      `SELECT count(*)::text AS total FROM grants WHERE user_id = $1`,
      [userId],
    );
    expect(left[0]?.total).toBe('0');

    const referralsLeft = await ctx.db.query<{ total: string }>(
      `SELECT count(*)::text AS total FROM referrals WHERE referrer_id = $1 OR referred_id = $1`,
      [userId],
    );
    expect(referralsLeft[0]?.total).toBe('0');
  });
});

describe('изоляция пользователей', () => {
  it('один код на двоих даёт каждому своё право', async () => {
    const first = await ensureUser(OTHER_USER);
    await giveChart(first);
    const code = await codes.create({ kind: 'all_access', days: 7, maxActivations: 2 });

    await activate(OTHER_USER, code.code, 200);
    await activate(FICTIONAL_USER, code.code, 200);

    const mine = await entitlements.getGrantEntitlements(userIdOf(FICTIONAL_USER));
    const theirs = await entitlements.getGrantEntitlements(first);

    // У второго пользователя карты нет — право ждёт, срок не начался.
    expect(mine.allAccessUntil).toBeNull();
    expect(theirs.allAccessUntil).not.toBeNull();

    const rows = await ctx.db.query<{ total: string }>(
      `SELECT count(*)::text AS total FROM grants WHERE code_id = $1`,
      [code.id],
    );
    expect(rows[0]?.total).toBe('2');
  });
});
