import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { INIT_DATA_HEADER } from '../src/modules/auth/init-data';
import { createTestContext, truncateAll, type TestContext } from './test-app';
import { signInitData } from './init-data-fixture';
import { FICTIONAL_USER, TEST_BOT_TOKEN } from './test-env';

/**
 * `test_only` через панель (итерация 43, долг 7.1).
 *
 * Флаг нельзя безопасно править в SQL: `test_only = false` превращает тариф за
 * 1 ⭐ в продаваемый всем, и заметить это некому. Поэтому в маршруте два шага —
 * при снятии флага требуется `confirm: "disable_test_plan"`. Тесты проверяют
 * обе стороны: без подтверждения флаг не снимается, с подтверждением — снимается,
 * и включение (закрыть тариф) подтверждения не требует.
 */

const ADMIN_TG_ID = '777000999';
const ADMIN = { ...FICTIONAL_USER, id: Number(ADMIN_TG_ID), username: 'admin_owner' };

let ctx: TestContext;

function adminInitData(): string {
  return signInitData({ botToken: TEST_BOT_TOKEN, user: ADMIN });
}

function patch(code: string, body: Record<string, unknown>) {
  return request(ctx.app.getHttpServer())
    .patch(`/api/v1/admin/plans/${code}`)
    .set(INIT_DATA_HEADER, adminInitData())
    .send(body);
}

async function seedPlans(): Promise<void> {
  await ctx.db.query(
    `INSERT INTO plans (code, kind, subscription_plan, stars, period_seconds, title, invoice_title,
                        description, price_label, paywall_title, paywall_subtitle, grants, sort,
                        is_active, test_only)
     VALUES ('test_1', 'subscription', 'week', 1, 604800, 'Тестовый тариф',
             'Тестовый тариф', 'Описание', '1 ⭐', 'Заголовок', 'Подзаголовок',
             '{"fullForecast":true,"askPerDay":-1,"compatPerMonth":1,"solarIncluded":true}'::jsonb,
             5, true, true),
            ('month_399', 'subscription', 'month', 399, 2592000, 'Подписка на месяц',
             'Подписка на месяц', 'Описание', '399 ⭐', 'Заголовок', 'Подзаголовок',
             '{"fullForecast":true,"askPerDay":-1,"compatPerMonth":1,"solarIncluded":true}'::jsonb,
             10, true, false),
            ('founder_month', 'subscription', 'month', 199, 2592000, 'Первый месяц',
             'Первый месяц', 'Описание', '199 ⭐', 'Заголовок', 'Подзаголовок',
             '{"fullForecast":true,"askPerDay":-1,"compatPerMonth":1,"solarIncluded":true}'::jsonb,
             99, false, false)
     ON CONFLICT (code) DO UPDATE
        SET stars = EXCLUDED.stars, version = 1, test_only = EXCLUDED.test_only, is_active = EXCLUDED.is_active`,
  );
}

async function flagOf(code: string): Promise<{ test_only: boolean; stars: number; version: number }> {
  const row = await ctx.db.queryOne<{ test_only: boolean; stars: number; version: number }>(
    `SELECT test_only, stars, version FROM plans WHERE code = $1`,
    [code],
  );
  return row ?? { test_only: false, stars: 0, version: 0 };
}

beforeAll(async () => {
  ctx = await createTestContext({ env: { ADMIN_TG_ID } });
});

afterAll(async () => {
  // `plans` не чистится между файлами (это справочник), поэтому `test_1` с
  // `is_active = true` переезжал в следующий файл. Полный прогон round44
  // показал цену: `prod-guard-startup.spec.ts` видел «активный тестовый тариф»
  // в базе, которую сам не пачкал, и краснел. Убираем за собой.
  await ctx.db.query(`UPDATE plans SET is_active = false WHERE test_only`);
  await ctx.close();
});

beforeEach(async () => {
  await truncateAll(ctx.db);
  await seedPlans();
});

describe('PATCH /admin/plans/{code} — test_only', () => {
  it('включить тестовый режим можно без подтверждения', async () => {
    const response = await patch('month_399', {
      test_only: true,
      comment: 'готовим тестовый прогон оплаты',
      base_version: 1,
    }).expect(200);

    expect((response.body as { plan: { test_only: boolean } }).plan.test_only).toBe(true);
    expect((await flagOf('month_399')).test_only).toBe(true);
  });

  it('снять флаг без confirm — 422 confirmation_required, флаг не меняется', async () => {
    const response = await patch('test_1', {
      test_only: false,
      comment: 'хотим продавать этот тариф',
      base_version: 1,
    }).expect(422);

    expect((response.body as { details: { reason: string } }).details.reason).toBe(
      'confirmation_required',
    );
    expect((await flagOf('test_1')).test_only).toBe(true);
  });

  it('снять флаг с confirm: "disable_test_plan" — можно', async () => {
    const response = await patch('test_1', {
      test_only: false,
      confirm: 'disable_test_plan',
      comment: 'владелец подтвердил продажу по этой цене',
      base_version: 1,
    }).expect(200);

    expect((response.body as { plan: { test_only: boolean } }).plan.test_only).toBe(false);
    expect((await flagOf('test_1')).test_only).toBe(false);

    // Отдельное действие в журнале: «снял тестовый режим» — это не «поменял цену».
    const audit = await ctx.db.queryOne<{ action: string; before: unknown; after: unknown }>(
      `SELECT action, before, after FROM admin_audit WHERE action = 'plan.test_only_change'`,
    );
    expect(audit?.before).toEqual({ test_only: true });
    expect(audit?.after).toEqual({ test_only: false });
  });

  it('неверная строка подтверждения — 422, флаг не меняется', async () => {
    await patch('test_1', {
      test_only: false,
      confirm: 'yes',
      comment: 'подтверждение не то',
      base_version: 1,
    }).expect(422);

    expect((await flagOf('test_1')).test_only).toBe(true);
  });

  it('ни цены, ни флага — 422 nothing_to_update', async () => {
    const response = await patch('month_399', {
      comment: 'просто комментарий',
      base_version: 1,
    }).expect(422);

    expect((response.body as { details: { reason: string } }).details.reason).toBe(
      'nothing_to_update',
    );
  });

  it('цена и флаг одной ручкой: две записи, одна транзакция', async () => {
    const response = await patch('test_1', {
      price_stars: 2,
      test_only: false,
      confirm: 'disable_test_plan',
      comment: 'цена 2 звезды, режим снят',
      base_version: 1,
    }).expect(200);

    const plan = response.body as { plan: { price_stars: number; test_only: boolean; version: number } };
    expect(plan.plan).toMatchObject({ price_stars: 2, test_only: false, version: 2 });

    const audit = await ctx.db.query<{ action: string }>(
      `SELECT action FROM admin_audit ORDER BY id`,
    );
    expect(audit.map((row) => row.action)).toEqual(['plan.price_change', 'plan.test_only_change']);
  });

  it('тариф основателей: цену менять нельзя, флаг — можно', async () => {
    const locked = await patch('founder_month', {
      price_stars: 249,
      comment: 'хотим поднять цену основателям',
      base_version: 1,
    }).expect(403);
    expect((locked.body as { details: { reason: string } }).details.reason).toBe('founder_plan_locked');

    await patch('founder_month', {
      test_only: true,
      comment: 'временно закрываем тариф основателей',
      base_version: 1,
    }).expect(200);

    expect(await flagOf('founder_month')).toMatchObject({ test_only: true, stars: 199 });
  });

  it('устаревшая base_version — 409 и для флага', async () => {
    await patch('month_399', {
      price_stars: 449,
      comment: 'поднимаем цену',
      base_version: 1,
    }).expect(200);

    const stale = await patch('month_399', {
      test_only: true,
      comment: 'включаем тестовый режим',
      base_version: 1,
    }).expect(409);

    expect((stale.body as { details: { reason: string } }).details.reason).toBe('price_changed');
    expect((await flagOf('month_399')).test_only).toBe(false);
  });

  it('неизвестное поле — 422 unknown_field', async () => {
    const response = await patch('month_399', {
      test_only: true,
      is_active: false,
      comment: 'пробуем выключить тариф',
      base_version: 1,
    }).expect(422);

    expect((response.body as { details: { reason: string } }).details.reason).toBe('unknown_field');
  });
});
