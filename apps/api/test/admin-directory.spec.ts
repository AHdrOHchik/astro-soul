import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { INIT_DATA_HEADER } from '../src/modules/auth/init-data';
import { UsersRepository } from '../src/modules/users/users.repository';
import { createTestContext, truncateAll, type TestContext } from './test-app';
import { signInitData } from './init-data-fixture';
import { FICTIONAL_USER, TEST_BOT_TOKEN } from './test-env';

/**
 * Справочники панели (итерация 43, контракт 1.6.17): основатели, партнёры,
 * платежи.
 *
 * Проверяется то, что нельзя увидеть глазами: в списках нет ПДн, в агрегатах
 * партнёров нет **ни одного** идентификатора (партнёр — внешняя сторона),
 * `paid_users` считает людей, а не платежи, `revenue_stars` не задваивается при
 * нескольких активациях одного человека и не включает возвраты, а пагинация
 * курсором не показывает одну строку дважды.
 */

const ADMIN_TG_ID = '777000999';
const ADMIN = { ...FICTIONAL_USER, id: Number(ADMIN_TG_ID), username: 'admin_owner' };

const USER_A = '555000111';
const USER_B = '555000222';
const USER_C = '555000333';

let ctx: TestContext;
let users: UsersRepository;
let userA: string;
let userB: string;
let userC: string;

function adminInitData(): string {
  return signInitData({ botToken: TEST_BOT_TOKEN, user: ADMIN });
}

function asAdmin(path: string) {
  return request(ctx.app.getHttpServer()).get(path).set(INIT_DATA_HEADER, adminInitData());
}

async function seedPlan(): Promise<void> {
  await ctx.db.query(
    `INSERT INTO plans (code, kind, subscription_plan, stars, period_seconds, title, invoice_title,
                        description, price_label, paywall_title, paywall_subtitle, grants, sort,
                        is_active, test_only)
     VALUES ('month_399', 'subscription', 'month', 399, 2592000, 'Подписка на месяц',
             'Подписка на месяц', 'Описание', '399 ⭐', 'Заголовок', 'Подзаголовок',
             '{"fullForecast":true,"askPerDay":-1,"compatPerMonth":1,"solarIncluded":true}'::jsonb,
             10, true, false)
     ON CONFLICT (code) DO NOTHING`,
  );
}

/**
 * Три человека: A и B — по партнёрскому коду, C — сам.
 *
 * У B два платежа по 399: `revenue_stars` обязан посчитать 798, а `paid_users`
 * — одного человека (а не два платежа). У A платёж возвращён: в сумму он не
 * попадает вовсе, но «заплатил хотя бы раз» остаётся правдой — возврат был
 * позже.
 */
async function seedPeople(): Promise<void> {
  const rows: [string, string][] = [
    [userA, USER_A],
    [userB, USER_B],
    [userC, USER_C],
  ];

  for (const [id, tg] of rows) {
    await ctx.db.query(`INSERT INTO users (id, telegram_id) VALUES ($1, $2)`, [id, BigInt(tg).toString()]);
  }

  // Основатели: места по порядку, даты разные — порядок проверяется по ним.
  await ctx.db.query(
    `INSERT INTO founders (user_id, place, created_at) VALUES
       ($1, 1, now() - interval '3 days'),
       ($2, 2, now() - interval '2 days'),
       ($3, 3, now() - interval '1 day')`,
    [userA, userB, userC],
  );

  // Право основателя — только у A (у B и C его нет: так видно, что JOIN не
  // подставляет чужую выдачу).
  await ctx.db.query(
    `INSERT INTO grants (user_id, kind, source, days, starts_at, expires_at)
     VALUES ($1, 'all_access', 'founder', 30, now() - interval '3 days', now() + interval '27 days')`,
    [userA],
  );

  // Коды: partner_a — два кода, partner_b — один и без активаций.
  const codes = await ctx.db.query<{ id: string; code: string }>(
    `INSERT INTO access_codes (code, kind, days, max_activations, partner_name)
     VALUES ('AAAABBBB', 'all_access', 30, 10, 'partner_a'),
            ('CCCCDDDD', 'all_access', 30, 10, 'partner_a'),
            ('EEEEFFFF', 'single_report', NULL, 10, 'partner_b')
     RETURNING id::text AS id, code`,
  );

  const byCode = new Map(codes.map((row) => [row.code, row.id]));
  const partnerA = byCode.get('AAAABBBB') ?? '';

  // A активировал два кода partner_a (две активации одного человека — в
  // `activated_users` это один, в `activations_total` — два), B — один.
  const second = byCode.get('CCCCDDDD') ?? '';
  await ctx.db.query(
    `INSERT INTO access_code_activations (code_id, user_id) VALUES ($1, $2), ($1, $3), ($4, $5)`,
    [partnerA, userA, userB, second, userA],
  );

  // Времена разные намеренно: `created_at` у трёх строк одного `INSERT` был бы
  // одинаковым, и «новые сверху» решался бы случайным `id`. Панель листает по
  // `(created_at, id)` — значит и тест должен задавать порядок, а не надеяться
  // на него.
  await ctx.db.query(
    `INSERT INTO payments (user_id, telegram_id, plan_code, total_amount,
                           telegram_payment_charge_id, status, processed, refunded_at, created_at)
     VALUES ($1, $2, 'month_399', 399, 'charge-a-1', 'refunded', true, now() - interval '3 hours',
             now() - interval '3 hours'),
            ($3, $4, 'month_399', 399, 'charge-b-1', 'paid', true, NULL, now() - interval '2 hours'),
            ($3, $4, 'month_399', 399, 'charge-b-2', 'paid', true, NULL, now() - interval '1 hour')`,
    [userA, BigInt(USER_A).toString(), userB, BigInt(USER_B).toString()],
  );
}

beforeAll(async () => {
  ctx = await createTestContext({ env: { ADMIN_TG_ID } });
  users = ctx.app.get(UsersRepository);
  userA = users.userIdFor(BigInt(USER_A));
  userB = users.userIdFor(BigInt(USER_B));
  userC = users.userIdFor(BigInt(USER_C));
});

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  await truncateAll(ctx.db);
  await seedPlan();
  await seedPeople();
});

describe('GET /admin/founders', () => {
  it('отдаёт места по дате заявки, без ПДн и без имени', async () => {
    const response = await asAdmin('/api/v1/admin/founders').expect(200);
    const body = response.body as {
      items: {
        place: number;
        user_id: string;
        telegram_id: string;
        grant_kind: string | null;
        expires_at: string | null;
        code_activated: boolean;
      }[];
      next_cursor: string | null;
    };

    expect(body.items.map((item) => item.place)).toEqual([1, 2, 3]);
    expect(body.items.map((item) => item.telegram_id)).toEqual([USER_A, USER_B, USER_C]);
    // ПДн нет: ни одного ключа, которого не должно быть.
    for (const item of body.items) {
      expect(Object.keys(item).sort()).toEqual([
        'code_activated',
        'created_at',
        'expires_at',
        'grant_kind',
        'place',
        'telegram_id',
        'user_id',
      ]);
      // Имени нет и в контракте (1.6.18): в `users` нет колонки `username`, а
      // постоянный null был обещанием поля, которого не будет.
      expect(item).not.toHaveProperty('username');
    }

    // Право основателя — только у первого; у остальных null, а не «последнее
    // попавшееся» право.
    expect(body.items[0]).toMatchObject({ grant_kind: 'all_access', code_activated: true });
    expect(body.items[1]?.grant_kind).toBeNull();
    expect(body.next_cursor).toBeNull();
  });

  it('code_activated = false у того, кто пришёл сам', async () => {
    const response = await asAdmin('/api/v1/admin/founders').expect(200);
    const body = response.body as { items: { telegram_id: string; code_activated: boolean }[] };

    expect(body.items.find((item) => item.telegram_id === USER_C)?.code_activated).toBe(false);
  });

  it('курсор: страница по одному, без повторов и без пропусков', async () => {
    const first = await asAdmin('/api/v1/admin/founders?limit=1').expect(200);
    const firstBody = first.body as { items: { place: number }[]; next_cursor: string | null };

    expect(firstBody.items.map((item) => item.place)).toEqual([1]);
    expect(firstBody.next_cursor).not.toBeNull();

    const second = await asAdmin(
      `/api/v1/admin/founders?limit=1&cursor=${encodeURIComponent(firstBody.next_cursor ?? '')}`,
    ).expect(200);
    const secondBody = second.body as { items: { place: number }[]; next_cursor: string | null };

    expect(secondBody.items.map((item) => item.place)).toEqual([2]);
    expect(secondBody.next_cursor).not.toBeNull();
  });

  it('границы: limit=51 и битый курсор — 422', async () => {
    await asAdmin('/api/v1/admin/founders?limit=51').expect(422);
    await asAdmin('/api/v1/admin/founders?limit=0').expect(422);
    await asAdmin('/api/v1/admin/founders?cursor=не-курсор').expect(422);
  });

  it('чужому — 403', async () => {
    await request(ctx.app.getHttpServer())
      .get('/api/v1/admin/founders')
      .set(INIT_DATA_HEADER, signInitData({ botToken: TEST_BOT_TOKEN, user: FICTIONAL_USER }))
      .expect(403);
  });
});

describe('GET /admin/partners', () => {
  it('считает активации, людей и деньги; без идентификаторов', async () => {
    const response = await asAdmin('/api/v1/admin/partners').expect(200);
    const body = response.body as {
      items: {
        partner_name: string;
        codes_total: number;
        activations_total: number;
        activated_users: number;
        paid_users: number;
        revenue_stars: number;
        last_activation_at: string | null;
      }[];
    };

    const partnerA = body.items.find((item) => item.partner_name === 'partner_a');
    const partnerB = body.items.find((item) => item.partner_name === 'partner_b');

    expect(partnerA).toMatchObject({
      codes_total: 2,
      // Три активации двух разных людей: одна строка — один человек дважды.
      activations_total: 3,
      activated_users: 2,
      // A заплатил и вернул, B заплатил дважды: заплатили двое.
      paid_users: 2,
      // 399 + 399 у B; возврат A не вычитается, а не входит вовсе.
      revenue_stars: 798,
    });
    expect(partnerA?.last_activation_at).toMatch(/^\d{4}-\d{2}-\d{2}T/u);

    // Партнёр без активаций остаётся в списке: «раздали и никто не пришёл» —
    // это ответ, а не пустая строка.
    expect(partnerB).toMatchObject({
      codes_total: 1,
      activations_total: 0,
      activated_users: 0,
      paid_users: 0,
      revenue_stars: 0,
      last_activation_at: null,
    });
  });

  it('не отдаёт ни одного идентификатора: ни user_id, ни telegram_id, ни кода', async () => {
    const response = await asAdmin('/api/v1/admin/partners').expect(200);
    const raw = JSON.stringify(response.body);

    for (const secret of [userA, userB, userC, USER_A, USER_B, USER_C, 'AAAABBBB', 'CCCCDDDD']) {
      expect(raw.includes(secret), `в ответе партнёров нашёлся идентификатор ${secret}`).toBe(false);
    }

    for (const item of response.body.items as Record<string, unknown>[]) {
      expect(Object.keys(item).sort()).toEqual([
        'activated_users',
        'activations_total',
        'codes_total',
        'last_activation_at',
        'paid_users',
        'partner_name',
        'revenue_stars',
      ]);
    }
  });

  it('чужому — 403', async () => {
    await request(ctx.app.getHttpServer())
      .get('/api/v1/admin/partners')
      .set(INIT_DATA_HEADER, signInitData({ botToken: TEST_BOT_TOKEN, user: FICTIONAL_USER }))
      .expect(403);
  });
});

describe('GET /admin/payments', () => {
  it('без фильтров — последние платежи, новые сверху', async () => {
    const response = await asAdmin('/api/v1/admin/payments').expect(200);
    const body = response.body as {
      items: { charge_id: string; amount_stars: number; status: string; currency: string }[];
      next_cursor: string | null;
    };

    expect(body.items.map((item) => item.charge_id)).toEqual(['charge-b-2', 'charge-b-1', 'charge-a-1']);
    expect(body.items[0]).toMatchObject({ amount_stars: 399, currency: 'XTR', status: 'paid' });
    expect(body.next_cursor).toBeNull();
  });

  it('поиск по charge_id — главный сценарий поддержки', async () => {
    const response = await asAdmin('/api/v1/admin/payments?charge_id=charge-b-1').expect(200);
    const body = response.body as { items: { charge_id: string; user_id: string }[] };

    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.charge_id).toBe('charge-b-1');
    expect(body.items[0]?.user_id).toBe(userB);

    // Не найдено — пустой список, а не 404: «такого чека нет» — нормальный ответ.
    const missing = await asAdmin('/api/v1/admin/payments?charge_id=charge-zzz').expect(200);
    expect((missing.body as { items: unknown[] }).items).toEqual([]);
  });

  it('фильтры status и user_id, включая возвраты', async () => {
    const refunded = await asAdmin('/api/v1/admin/payments?status=refunded').expect(200);
    const refundedBody = refunded.body as { items: { charge_id: string; refunded_at: string | null }[] };

    expect(refundedBody.items.map((item) => item.charge_id)).toEqual(['charge-a-1']);
    expect(refundedBody.items[0]?.refunded_at).toMatch(/^\d{4}-\d{2}-\d{2}T/u);

    const byUser = await asAdmin(`/api/v1/admin/payments?user_id=${userB}`).expect(200);
    expect((byUser.body as { items: { charge_id: string }[] }).items.map((item) => item.charge_id)).toEqual([
      'charge-b-2',
      'charge-b-1',
    ]);
  });

  it('границы: неизвестный status, битый user_id, limit вне диапазона — 422', async () => {
    await asAdmin('/api/v1/admin/payments?status=cancelled').expect(422);
    await asAdmin('/api/v1/admin/payments?user_id=не-uuid').expect(422);
    await asAdmin('/api/v1/admin/payments?limit=101').expect(422);
    await asAdmin('/api/v1/admin/payments?charge_id=ab').expect(422);
  });

  it('курсор: страница по одному, без повторов', async () => {
    const first = await asAdmin('/api/v1/admin/payments?limit=1').expect(200);
    const firstBody = first.body as { items: { charge_id: string }[]; next_cursor: string | null };

    expect(firstBody.items.map((item) => item.charge_id)).toEqual(['charge-b-2']);

    const second = await asAdmin(
      `/api/v1/admin/payments?limit=1&cursor=${encodeURIComponent(firstBody.next_cursor ?? '')}`,
    ).expect(200);

    expect((second.body as { items: { charge_id: string }[] }).items.map((item) => item.charge_id)).toEqual([
      'charge-b-1',
    ]);
  });

  it('чужому — 403', async () => {
    await request(ctx.app.getHttpServer())
      .get('/api/v1/admin/payments')
      .set(INIT_DATA_HEADER, signInitData({ botToken: TEST_BOT_TOKEN, user: FICTIONAL_USER }))
      .expect(403);
  });
});
