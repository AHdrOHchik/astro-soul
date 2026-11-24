import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { INIT_DATA_HEADER } from '../src/modules/auth/init-data';
import { AccessService } from '../src/modules/entitlements/access.service';
import { UsersRepository } from '../src/modules/users/users.repository';
import { createTestContext, truncateAll, type TestContext } from './test-app';
import { signInitData } from './init-data-fixture';
import { makeFakeTelegram, type FakeTelegram } from './fake-telegram';
import { FICTIONAL_USER, TEST_BOT_TOKEN } from './test-env';

/**
 * Панель поддержки и цен (итерация 41, контракт 1.6.16).
 *
 * Проверяется то, что нельзя увидеть глазами в ответе: список пользователей не
 * отдаёт ПДн ни при каком фильтре, карточка **пишет** `user.card_view` в аудит,
 * сумма возврата не приходит в запросе и не может быть частичной, ошибка
 * Telegram не помечает платёж, забаненный теряет доступ **до** проверки
 * подписки и грантов, а перезапуск упавшего разбора не создаёт второго платежа.
 */

const ADMIN_TG_ID = '777000999';
const ADMIN = { ...FICTIONAL_USER, id: Number(ADMIN_TG_ID), username: 'admin_owner' };

/** Пользователь поддержки: вымышленный, с ПДн — чтобы проверять их отсутствие. */
const USER_TG_ID = '555000111';

let ctx: TestContext;
let users: UsersRepository;
let access: AccessService;
let telegram: FakeTelegram;
let userId: string;

function adminInitData(): string {
  return signInitData({ botToken: TEST_BOT_TOKEN, user: ADMIN });
}

function api() {
  return request(ctx.app.getHttpServer());
}

function asAdmin(method: 'get' | 'post' | 'patch', path: string) {
  return api()[method](path).set(INIT_DATA_HEADER, adminInitData());
}

/** Тарифы кладём напрямую: тестовый стенд сид не запускает. */
async function seedPlans(): Promise<void> {
  await ctx.db.query(
    `INSERT INTO plans (code, kind, subscription_plan, stars, period_seconds, title, invoice_title,
                        description, price_label, paywall_title, paywall_subtitle, grants, sort,
                        is_active, test_only)
     VALUES ('month_399', 'subscription', 'month', 399, 2592000, 'Подписка на месяц',
             'Подписка на месяц', 'Описание', '399 ⭐', 'Заголовок', 'Подзаголовок',
             '{"fullForecast":true,"askPerDay":-1,"compatPerMonth":1,"solarIncluded":true}'::jsonb,
             10, true, false),
            ('founder_month', 'subscription', 'month', 199, 2592000, 'Первый месяц',
             'Первый месяц', 'Описание', '199 ⭐', 'Заголовок', 'Подзаголовок',
             '{"fullForecast":true,"askPerDay":-1,"compatPerMonth":1,"solarIncluded":true}'::jsonb,
             99, false, false)
     -- Сброс на каждом тесте: таблица plans не чистится между тестами (это
     -- каталог), и без сброса цена и версия «переезжали» из теста в тест.
     ON CONFLICT (code) DO UPDATE
        SET stars = EXCLUDED.stars, version = 1, test_only = EXCLUDED.test_only`,
  );
}

async function seedUser(): Promise<void> {
  await ctx.db.query(`INSERT INTO users (id, telegram_id) VALUES ($1, $2)`, [
    userId,
    BigInt(USER_TG_ID).toString(),
  ]);
  await ctx.db.query(
    `INSERT INTO profiles (user_id, birth_date, birth_time, time_mode, place_name, place_country,
                           place_lat, place_lon, place_tz, consent_at)
     VALUES ($1, '1990-05-04', '14:35', 'exact', 'Москва', 'RU', 55.75, 37.61, 'Europe/Moscow', now())`,
    [userId],
  );
  await ctx.db.query(
    `INSERT INTO charts (user_id, input_hash, data, engine_version, time_known)
     VALUES ($1, 'chart-hash-1', '{"chart":{}}'::jsonb, 'engine-test', true)`,
    [userId],
  );
}

async function seedPayment(chargeId: string, status = 'processed'): Promise<string> {
  const row = await ctx.db.queryOne<{ id: string }>(
    `INSERT INTO payments (user_id, telegram_id, plan_code, total_amount, telegram_payment_charge_id,
                           status, processed, refunded_at)
     VALUES ($1, $2, 'month_399', 399, $3, $4::payment_status, true,
             CASE WHEN $4::text = 'refunded' THEN now() ELSE NULL END)
     RETURNING id::text AS id`,
    [userId, BigInt(USER_TG_ID).toString(), chargeId, status],
  );

  return row?.id ?? '';
}

beforeAll(async () => {
  telegram = makeFakeTelegram();
  ctx = await createTestContext({
    env: { ADMIN_TG_ID },
    telegram,
  });
  users = ctx.app.get(UsersRepository);
  access = ctx.app.get(AccessService);
  userId = users.userIdFor(BigInt(USER_TG_ID));
});

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  await truncateAll(ctx.db);
  // Фейк Bot API один на файл: без сброса вызовы предыдущего теста попадают в
  // «сколько раз отправили» следующего.
  telegram.pushes.length = 0;
  telegram.refunds.length = 0;
  await seedPlans();
  await seedUser();
});

describe('цены тарифов', () => {
  it('список отдаёт все тарифы, `test_only` под своим именем и без `is_test`', async () => {
    const response = await asAdmin('get', '/api/v1/admin/plans').expect(200);
    const items = response.body.items as Record<string, unknown>[];
    const month = items.find((item) => item['code'] === 'month_399');

    expect(month).toBeDefined();
    expect(month).toMatchObject({
      price_stars: 399,
      period_days: 30,
      test_only: false,
      active: true,
      founder_only: false,
    });
    // Псевдоним запрещён: панель читает то же имя, что в БД.
    expect(month).not.toHaveProperty('is_test');
    expect(items.find((item) => item['code'] === 'founder_month')).toMatchObject({
      founder_only: true,
    });
  });

  it('PATCH меняет цену, пишет историю и аудит в одной транзакции', async () => {
    const before = await asAdmin('get', '/api/v1/admin/plans').expect(200);
    const version = (
      before.body.items as { code: string; version: number }[]
    ).find((item) => item.code === 'month_399')?.version;

    const patched = await asAdmin('patch', '/api/v1/admin/plans/month_399')
      .send({ price_stars: 499, comment: 'подняли цену после теста', base_version: version })
      .expect(200);

    expect(patched.body.plan).toMatchObject({ code: 'month_399', price_stars: 499 });
    expect(patched.body.plan.version).toBe((version ?? 0) + 1);
    expect(typeof patched.body.effective_from).toBe('string');

    // Цена — из таблицы `plans`, а не из ответа.
    const row = await ctx.db.queryOne<{ stars: number; version: number }>(
      `SELECT stars, version FROM plans WHERE code = 'month_399'`,
    );
    expect(row).toMatchObject({ stars: 499 });

    const history = await asAdmin('get', '/api/v1/admin/plans/month_399/history').expect(200);
    expect(history.body.items[0]).toMatchObject({
      price_stars: 499,
      previous_price_stars: 399,
      comment: 'подняли цену после теста',
    });

    const audit = await ctx.db.queryOne<{ action: string; before: unknown; after: unknown }>(
      `SELECT action, before, after FROM admin_audit WHERE action = 'plan.price_change'`,
    );
    expect(audit?.action).toBe('plan.price_change');
    expect(audit?.before).toMatchObject({ price_stars: 399 });
    expect(audit?.after).toMatchObject({ price_stars: 499 });
  });

  it('устаревшая версия — 409 price_changed с текущей ценой, цена не меняется', async () => {
    const response = await asAdmin('patch', '/api/v1/admin/plans/month_399')
      .send({ price_stars: 599, comment: 'вторая вкладка', base_version: 999 })
      .expect(409);

    expect(response.body.details.reason).toBe('price_changed');
    expect(response.body.details.current).toMatchObject({ price_stars: 399 });

    const row = await ctx.db.queryOne<{ stars: number }>(
      `SELECT stars FROM plans WHERE code = 'month_399'`,
    );
    expect(row?.stars).toBe(399);
  });

  it('тариф основателей закрыт: 403 founder_plan_locked, цена не меняется', async () => {
    const response = await asAdmin('patch', '/api/v1/admin/plans/founder_month')
      .send({ price_stars: 99, comment: 'хочу дешевле', base_version: 1 })
      .expect(403);

    expect(response.body.details.reason).toBe('founder_plan_locked');

    const row = await ctx.db.queryOne<{ stars: number }>(
      `SELECT stars FROM plans WHERE code = 'founder_month'`,
    );
    expect(row?.stars).toBe(199);
  });

  it('неизвестное поле по-прежнему 422, а `test_only` с 1.6.17 — не неизвестное', async () => {
    // Контракт 1.6.16 запрещал трогать флаг из панели; с 1.6.17 он стал полем
    // запроса (с обязательным `confirm` на снятие — см. `plan-test-only.spec.ts`).
    // Здесь проверяется то, что осталось верным: посторонние поля не проходят, а
    // `test_only: true` флаг ставит.
    const unknown = await asAdmin('patch', '/api/v1/admin/plans/month_399')
      .send({ price_stars: 499, comment: 'выключить тариф', base_version: 1, is_active: false })
      .expect(422);

    expect(unknown.body.details.reason).toBe('unknown_field');

    await asAdmin('patch', '/api/v1/admin/plans/month_399')
      .send({ test_only: true, comment: 'пометить тестовым', base_version: 1 })
      .expect(200);

    const row = await ctx.db.queryOne<{ test_only: boolean; stars: number }>(
      `SELECT test_only, stars FROM plans WHERE code = 'month_399'`,
    );
    expect(row).toMatchObject({ test_only: true, stars: 399 });
  });
});

describe('поиск пользователей', () => {
  it('ровно один фильтр: два или ни одного — 422 invalid_search', async () => {
    const two = await asAdmin('get', `/api/v1/admin/users?telegram_id=${USER_TG_ID}&q=55`).expect(422);
    expect(two.body.details.reason).toBe('invalid_search');

    const none = await asAdmin('get', '/api/v1/admin/users').expect(422);
    expect(none.body.details.reason).toBe('invalid_search');
  });

  it('список без ПДн при любом фильтре', async () => {
    const byTelegram = await asAdmin('get', `/api/v1/admin/users?telegram_id=${USER_TG_ID}`).expect(200);
    expect(byTelegram.body.items).toHaveLength(1);
    expect(byTelegram.body.truncated).toBe(false);

    const item = byTelegram.body.items[0] as Record<string, unknown>;
    expect(item).toMatchObject({ user_id: userId, banned: false });
    for (const forbidden of ['telegram_id', 'birth_date', 'birth_time', 'place_name', 'profile']) {
      expect(item).not.toHaveProperty(forbidden);
    }

    const alias = item['alias'] as string;
    const byAlias = await asAdmin('get', `/api/v1/admin/users?alias=${alias}`).expect(200);
    expect(byAlias.body.items[0]).toMatchObject({ user_id: userId });

    const byQuery = await asAdmin('get', `/api/v1/admin/users?q=${USER_TG_ID.slice(-6)}`).expect(200);
    expect(byQuery.body.items[0]).toMatchObject({ user_id: userId });
  });

  it('карточка отдаёт дату рождения и пишет user.card_view в аудит', async () => {
    const card = await asAdmin('get', `/api/v1/admin/users/${userId}`).expect(200);

    expect(card.body).toMatchObject({
      user_id: userId,
      telegram_id: USER_TG_ID,
      profile: { birth_date: '1990-05-04', time_precision: 'exact', place_name: 'Москва' },
    });
    expect(card.body.counts).toMatchObject({ reports: 0, compatibility: 0 });

    const audit = await ctx.db.queryOne<{ action: string; entity: string }>(
      `SELECT action, entity FROM admin_audit WHERE entity_id = $1`,
      [userId],
    );
    expect(audit).toMatchObject({ action: 'user.card_view', entity: 'user' });
  });

  it('не-UUID в пути — 404, а не 500 из Postgres', async () => {
    await asAdmin('get', '/api/v1/admin/users/not-a-uuid').expect(404);
  });
});

describe('возврат', () => {
  it('сумма в запросе запрещена: 422 refund_amount_not_allowed', async () => {
    await seedPayment('charge-sum-1');

    const response = await asAdmin('post', `/api/v1/admin/users/${userId}/refund`)
      .send({ charge_id: 'charge-sum-1', reason: 'передумал', amount: 199 })
      .expect(422);

    expect(response.body.details.reason).toBe('refund_amount_not_allowed');
    expect(telegram.refunds).toHaveLength(0);
  });

  it('чужой charge_id — 404, возврат не отправлен', async () => {
    await seedPayment('charge-own-1');

    const response = await asAdmin('post', `/api/v1/admin/users/${userId}/refund`)
      .send({ charge_id: 'charge-unknown', reason: 'передумал' })
      .expect(404);

    expect(response.body.details.reason).toBe('charge_not_found');
    expect(telegram.refunds).toHaveLength(0);
  });

  it('успех: сумма из платежа, статус refunded, доступ не отозван', async () => {
    const paymentId = await seedPayment('charge-ok-1');
    await ctx.db.query(
      `INSERT INTO entitlements (user_id, kind, chart_id, status, granted_at)
       SELECT $1, 'report', id, 'active', now() FROM charts WHERE user_id = $1`,
      [userId],
    );

    const response = await asAdmin('post', `/api/v1/admin/users/${userId}/refund`)
      .send({ charge_id: 'charge-ok-1', reason: 'жалоба на текст' })
      .expect(200);

    expect(response.body).toMatchObject({
      ok: true,
      charge_id: 'charge-ok-1',
      amount_stars: 399,
      access_revoked: false,
    });

    const payment = await ctx.db.queryOne<{ status: string; refunded_at: Date | null }>(
      `SELECT status::text AS status, refunded_at FROM payments WHERE id = $1`,
      [paymentId],
    );
    expect(payment?.status).toBe('refunded');
    expect(payment?.refunded_at).not.toBeNull();

    // Возврат не отзывает доступ: строка права остаётся активной.
    const entitlement = await ctx.db.queryOne<{ status: string }>(
      `SELECT status::text AS status FROM entitlements WHERE user_id = $1`,
      [userId],
    );
    expect(entitlement?.status).toBe('active');

    const audit = await ctx.db.queryOne<{ action: string; reason: string }>(
      `SELECT action, reason FROM admin_audit WHERE action = 'user.refund'`,
    );
    expect(audit).toMatchObject({ action: 'user.refund', reason: 'жалоба на текст' });
  });

  it('отказ Telegram — 502, платёж не помечен', async () => {
    const paymentId = await seedPayment('charge-fail-1');
    const original = telegram.refundStarPayment.bind(telegram);
    telegram.refundStarPayment = () => Promise.resolve(false);

    try {
      const response = await asAdmin('post', `/api/v1/admin/users/${userId}/refund`)
        .send({ charge_id: 'charge-fail-1', reason: 'повтор' })
        .expect(502);

      expect(response.body.details.reason).toBe('telegram_refund_failed');
    } finally {
      telegram.refundStarPayment = original;
    }

    const payment = await ctx.db.queryOne<{ status: string; refunded_at: Date | null }>(
      `SELECT status::text AS status, refunded_at FROM payments WHERE id = $1`,
      [paymentId],
    );
    expect(payment?.status).toBe('processed');
    expect(payment?.refunded_at).toBeNull();
  });

  it('повторный возврат — 409 already_refunded', async () => {
    await seedPayment('charge-twice-1', 'refunded');

    const response = await asAdmin('post', `/api/v1/admin/users/${userId}/refund`)
      .send({ charge_id: 'charge-twice-1', reason: 'ещё раз' })
      .expect(409);

    expect(response.body.details.reason).toBe('already_refunded');
  });
});

describe('бан', () => {
  it('забаненный теряет доступ раньше подписки и грантов, разбан возвращает', async () => {
    // Грант «всё включено»: без бана доступ есть именно благодаря ему.
    await ctx.db.query(
      `INSERT INTO grants (user_id, kind, source, days, starts_at, expires_at)
       VALUES ($1, 'all_access', 'admin', 30, now(), now() + interval '30 days')`,
      [userId],
    );

    expect(await access.hasAccess(userId, 'full_forecast')).toBe(true);

    await asAdmin('post', `/api/v1/admin/users/${userId}/ban`)
      .send({ banned: true, reason: 'спам в поддержку' })
      .expect(200);

    expect(await access.hasAccess(userId, 'full_forecast')).toBe(false);
    expect(await access.hasAccess(userId, 'ask')).toBe(false);

    // Покупка осталась покупкой: грант не тронут.
    const grant = await ctx.db.queryOne<{ revoked_at: Date | null }>(
      `SELECT revoked_at FROM grants WHERE user_id = $1`,
      [userId],
    );
    expect(grant?.revoked_at).toBeNull();

    const unban = await asAdmin('post', `/api/v1/admin/users/${userId}/ban`)
      .send({ banned: false })
      .expect(200);
    expect(unban.body).toMatchObject({ user_id: userId, banned: false, banned_at: null });

    expect(await access.hasAccess(userId, 'full_forecast')).toBe(true);

    const actions = await ctx.db.query<{ action: string }>(
      `SELECT action FROM admin_audit ORDER BY id`,
    );
    expect(actions.map((row) => row.action)).toEqual(['user.ban', 'user.unban']);
  });

  it('бан без причины — 422', async () => {
    await asAdmin('post', `/api/v1/admin/users/${userId}/ban`).send({ banned: true }).expect(422);
  });

  it('бан не отменяет подписку', async () => {
    await ctx.db.query(
      `INSERT INTO subscriptions (user_id, plan, status, expires_at)
       VALUES ($1, 'month', 'active', now() + interval '20 days')`,
      [userId],
    );

    await asAdmin('post', `/api/v1/admin/users/${userId}/ban`)
      .send({ banned: true, reason: 'проверка правил' })
      .expect(200);

    const subscription = await ctx.db.queryOne<{ status: string }>(
      `SELECT status::text AS status FROM subscriptions WHERE user_id = $1`,
      [userId],
    );
    expect(subscription?.status).toBe('active');
  });
});

describe('тестовый пуш', () => {
  it('уходит без окна 08:00, пишет push_log kind=test и аудит', async () => {
    const response = await asAdmin('post', `/api/v1/admin/users/${userId}/push`).expect(200);

    expect(response.body).toMatchObject({ user_id: userId, sent: true, kind: 'test' });
    expect(telegram.pushes).toHaveLength(1);

    const log = await ctx.db.queryOne<{ kind: string; sent: boolean; error: string | null }>(
      `SELECT kind, sent, error FROM push_log WHERE user_id = $1`,
      [userId],
    );
    expect(log).toMatchObject({ kind: 'test', sent: true, error: null });

    const audit = await ctx.db.queryOne<{ action: string }>(
      `SELECT action FROM admin_audit WHERE action = 'user.push_test'`,
    );
    expect(audit?.action).toBe('user.push_test');
  });

  it('второй тестовый пуш за сутки — 409 push_test_sent_24h', async () => {
    await asAdmin('post', `/api/v1/admin/users/${userId}/push`).expect(200);

    const second = await asAdmin('post', `/api/v1/admin/users/${userId}/push`).expect(409);
    expect(second.body.details.reason).toBe('push_test_sent_24h');
    expect(telegram.pushes).toHaveLength(1);
  });

  it('человек отключил пуши — 409 push_disabled, в Telegram не идём', async () => {
    await ctx.db.query(`UPDATE users SET push_enabled = false WHERE id = $1`, [userId]);

    const response = await asAdmin('post', `/api/v1/admin/users/${userId}/push`).expect(409);
    expect(response.body.details.reason).toBe('push_disabled');
    expect(telegram.pushes).toHaveLength(0);
  });
});

describe('разборы', () => {
  async function seedReport(status: string): Promise<string> {
    const chart = await ctx.db.queryOne<{ id: string }>(
      `SELECT id::text AS id FROM charts WHERE user_id = $1`,
      [userId],
    );
    const row = await ctx.db.queryOne<{ id: string }>(
      `INSERT INTO reports (chart_id, user_id, kind, status, error_code, attempts,
                            report_structure_version, prompt_version, chart_facts_version)
       VALUES ($1, $2, 'report', $3::report_status, $4, 2, 'structure_v1', 'prompts_v1', 'v1')
       RETURNING id::text AS id`,
      [chart?.id, userId, status, status === 'failed' ? 'validation' : null],
    );

    return row?.id ?? '';
  }

  it('перезапуск упавшего: 202, очередь, без второго платежа', async () => {
    const reportId = await seedReport('failed');
    await seedPayment('charge-report-1');
    const paymentsBefore = await ctx.db.queryOne<{ total: string }>(
      `SELECT count(*)::text AS total FROM payments`,
    );

    const response = await asAdmin('post', `/api/v1/admin/reports/${reportId}/regenerate`).expect(202);

    expect(response.body).toMatchObject({ report_id: reportId, state: 'queued', attempts: 2 });

    const audit = await ctx.db.queryOne<{ action: string }>(
      `SELECT action FROM admin_audit WHERE action = 'report.regenerate'`,
    );
    expect(audit?.action).toBe('report.regenerate');

    const paymentsAfter = await ctx.db.queryOne<{ total: string }>(
      `SELECT count(*)::text AS total FROM payments`,
    );
    expect(paymentsAfter?.total).toBe(paymentsBefore?.total);

    // `attempts` не меняются: лимит попыток относится к генерации, а не к
    // панели. `error_code` тоже не проверяем: фоновая генерация в тестах падает
    // сразу (провайдера LLM нет) — это её поведение, а не панели.
    const report = await ctx.db.queryOne<{ attempts: number }>(
      `SELECT attempts FROM reports WHERE id = $1`,
      [reportId],
    );
    expect(report?.attempts).toBe(2);
  });

  it('готовый разбор не перезапускается: 409 report_not_regenerable', async () => {
    const reportId = await seedReport('ready');

    const response = await asAdmin('post', `/api/v1/admin/reports/${reportId}/regenerate`).expect(409);
    expect(response.body.details.reason).toBe('report_not_regenerable');
  });

  it('лента отдаёт разборы с фильтрами и без текста', async () => {
    await seedReport('failed');

    const response = await asAdmin('get', '/api/v1/admin/reports?status=failed').expect(200);
    expect(response.body.items).toHaveLength(1);
    expect(response.body.items[0]).toMatchObject({ status: 'failed', error_code: 'validation' });
    expect(response.body.items[0]).not.toHaveProperty('chapters');
    expect(response.body.items[0]).not.toHaveProperty('teaser');
  });
});

describe('метрики и алерты дежурства', () => {
  it('push_test_sent_24h, admin_login_failed_24h и refunds_24h видны в /admin/metrics', async () => {
    await asAdmin('post', `/api/v1/admin/users/${userId}/push`).expect(200);
    await seedPayment('charge-metric-1');
    await asAdmin('post', `/api/v1/admin/users/${userId}/refund`)
      .send({ charge_id: 'charge-metric-1', reason: 'по жалобе' })
      .expect(200);

    await ctx.db.query(
      `INSERT INTO events (name, props, created_at) VALUES ('admin_login', '{"ok":false,"reason":"invalid_hash"}'::jsonb, now())`,
    );

    const metrics = await asAdmin('get', '/api/v1/admin/metrics').expect(200);

    expect(metrics.body.push_test_sent_24h).toBe(1);
    expect(metrics.body.admin_login_failed_24h).toBe(1);
    expect(metrics.body.refunds_24h).toBe(1);
  });

  it('алерт admin_login_failed входит в список и порог — 20', async () => {
    const response = await asAdmin('get', '/api/v1/admin/alerts').expect(200);
    const alerts = response.body.alerts as { id: string; threshold: number; fired: boolean }[];
    const alert = alerts.find((item) => item.id === 'admin_login_failed');

    expect(alert).toMatchObject({ threshold: 20, fired: false });
  });
});
