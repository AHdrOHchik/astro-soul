import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { INIT_DATA_HEADER } from '../src/modules/auth/init-data';
import { userIdFromTelegramId } from '../src/modules/users/pseudonym';
import { createTestContext, truncateAll, type TestContext } from './test-app';
import { signInitData } from './init-data-fixture';
import { FICTIONAL_USER, TEST_BOT_TOKEN, TEST_PEPPER } from './test-env';
import { makeFakeAstro } from './fake-astro';
import { makeFakeTelegram, type FakeTelegram } from './fake-telegram';

/**
 * `POST /subscription/cancel` (контракт 1.6.5, итерация 29).
 *
 * Продуктовый блокер: кнопка «открыть подписки в Telegram» вела на
 * `tg://settings/star_subscriptions`, которого не существует. Отменить
 * автопродление из приложения было нельзя вообще — только удалить аккаунт
 * (`DELETE /me`), потеряв всё купленное. Через период звёзды списывались молча.
 *
 * Что здесь проверяется, помимо очевидного «отмена работает»:
 *
 *   1. **Отмена ≠ возврат.** Доступ (`entitlements`, `is_active`,
 *      `expires_at`) остаётся прежним: человек уже оплатил этот период.
 *   2. **`auto_renew` меняется только после подтверждения Bot API.** При
 *      `ok:false` подписка в `GET /me` по-прежнему «продлится», а не «отменена»:
 *      иначе человек видит отмену, а звёзды всё равно списываются.
 *   3. **Повтор — `409`, а не `200`.** Клиент должен отличать «отменили сейчас»
 *      от «уже было отменено».
 *   4. **`no_charge_id` — наш дефект**, а не ошибка Telegram: отдельный счётчик.
 *   5. **`DELETE /me` не изменился** и не дёргает Bot API второй раз.
 */

const ADMIN_TG_ID = String(FICTIONAL_USER.id);
const JOBS_SECRET = 'test-jobs-secret-0123456789';
const CHARGE_ID = 'charge-sub-cancel-endpoint-1';

interface SubscriptionView {
  readonly plan: string;
  readonly is_active: boolean;
  readonly expires_at: string | null;
  readonly auto_renew: boolean;
  readonly cancelled_at?: string | null;
}

interface MeView {
  readonly subscription: SubscriptionView;
  readonly entitlements: Record<string, unknown>;
}

interface CancelBody {
  readonly status: string;
  readonly auto_renew: boolean;
  readonly current_period_end: string;
}

interface MetricsBody {
  readonly subscription_cancel_total_24h: number;
  readonly subscription_cancel_failed_24h: number;
  readonly subscription_cancel_no_charge_id_24h: number;
  readonly subscriptions_auto_renew_off: number;
  readonly subscriptions_cancelled_pending_telegram: number;
}

interface JobCounters {
  readonly telegram_cancel_retried: number;
  readonly telegram_cancel_cancelled: number;
  readonly telegram_cancel_gave_up: number;
}

let ctx: TestContext;
let telegram: FakeTelegram;

function initDataFor(): string {
  return signInitData({ botToken: TEST_BOT_TOKEN, user: FICTIONAL_USER });
}

function userId(): string {
  return userIdFromTelegramId(BigInt(FICTIONAL_USER.id), TEST_PEPPER);
}

beforeAll(async () => {
  telegram = makeFakeTelegram();
  ctx = await createTestContext({
    astro: makeFakeAstro(),
    telegram,
    // Тестовый тариф появляется в витрине только при флаге; для отмены он не
    // нужен, но флаг делает окружение тем же, что у владельца при проверке.
    env: { ADMIN_TG_ID, INTERNAL_JOB_SECRET: JOBS_SECRET, PAYMENTS_TEST_PLANS: '1' },
  });
});

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  await truncateAll(ctx.db);
  telegram.starSubscriptionCancels.length = 0;
  telegram.starCancelOutcome = 'cancelled';
});

/** Пользователь в базе (строка `users` появляется на первом `GET /me`). */
async function ensureUser(): Promise<string> {
  await request(ctx.app.getHttpServer())
    .get('/api/v1/me')
    .set(INIT_DATA_HEADER, initDataFor())
    .expect(200);

  return userId();
}

interface SubscriptionOptions {
  /** Код тарифа для строки платежа (по умолчанию годовой каталог). */
  readonly planCode?: string;
  readonly chargeId?: string | null;
  /** `subscriptions.plan` — значения из `SubscriptionState.plan`. */
  readonly plan?: 'trial' | 'week' | 'month' | 'year';
  readonly days?: number;
  readonly isTest?: boolean;
  readonly autoRenew?: boolean;
  readonly cancelState?: 'none' | 'cancelled' | 'failed' | 'gave_up';
  readonly cancelAttempts?: number;
}

/** Пользователь с подпиской: платёж (последний успешный) и строка подписки. */
async function userWithSubscription(options: SubscriptionOptions = {}): Promise<string> {
  const id = await ensureUser();
  const chargeId = options.chargeId === undefined ? CHARGE_ID : options.chargeId;

  if (chargeId !== null) {
    await ctx.db.query(
      `INSERT INTO payments (user_id, telegram_id, plan_code, total_amount,
                             telegram_payment_charge_id, status, processed, paid_at, is_test)
       VALUES ($1, $2, $3, 2990, $4, 'processed', true, now(), $5)`,
      [id, FICTIONAL_USER.id, options.planCode ?? 'year_2990', chargeId, options.isTest ?? false],
    );
  }

  await ctx.db.query(
    `INSERT INTO subscriptions
       (user_id, plan, status, expires_at, auto_renew, telegram_payment_charge_id,
        telegram_cancel_state, telegram_cancel_attempts)
     VALUES ($1, $2, 'active', now() + make_interval(days => $3), $4, $5, $6, $7)`,
    [
      id,
      options.plan ?? 'year',
      options.days ?? 365,
      options.autoRenew ?? true,
      chargeId,
      options.cancelState ?? 'none',
      options.cancelAttempts ?? 0,
    ],
  );

  return id;
}

function cancel(idempotencyKey: string | null = 'cancel-key-1') {
  const probe = request(ctx.app.getHttpServer())
    .post('/api/v1/subscription/cancel')
    .set(INIT_DATA_HEADER, initDataFor());

  return idempotencyKey === null ? probe : probe.set('Idempotency-Key', idempotencyKey);
}

async function me(): Promise<MeView> {
  const response = await request(ctx.app.getHttpServer())
    .get('/api/v1/me')
    .set(INIT_DATA_HEADER, initDataFor())
    .expect(200);
  const body: unknown = response.body;
  return body as MeView;
}

async function subscriptionRow(): Promise<{
  status: string;
  auto_renew: boolean;
  cancelled_at: Date | null;
  expires_at: Date;
  telegram_cancel_state: string;
  telegram_cancel_attempts: number;
} | null> {
  return ctx.db.queryOne(
    `SELECT status::text AS status, auto_renew, cancelled_at, expires_at,
            telegram_cancel_state::text AS telegram_cancel_state,
            telegram_cancel_attempts
       FROM subscriptions`,
  );
}

async function runRetentionJob(): Promise<JobCounters> {
  const response = await request(ctx.app.getHttpServer())
    .post('/api/v1/internal/jobs/run?job=pdn_retention_cleanup')
    .set('X-Jobs-Secret', JOBS_SECRET)
    .expect(202);
  const body: unknown = response.body;
  return body as JobCounters;
}

async function metrics(): Promise<MetricsBody> {
  const response = await request(ctx.app.getHttpServer())
    .get('/api/v1/admin/metrics')
    .set(INIT_DATA_HEADER, initDataFor())
    .expect(200);
  const body: unknown = response.body;
  return body as MetricsBody;
}

describe('POST /subscription/cancel — успех', () => {
  it('гасит автопродление, доступ остаётся, Bot API получил пару (user_id, charge_id)', async () => {
    await userWithSubscription();
    const before = await me();

    const response = await cancel().expect(200);
    const body = response.body as CancelBody;

    expect(body).toMatchObject({ status: 'cancelled', auto_renew: false });
    // Период не сокращён: тот же `expires_at`, что и в `/me` до отмены.
    expect(body.current_period_end).toBe(before.subscription.expires_at);

    // Стаб Bot API: правильный telegram_id и charge_id последнего платежа.
    expect(telegram.starSubscriptionCancels).toEqual([
      { userId: Number(FICTIONAL_USER.id), chargeId: CHARGE_ID },
    ]);

    const row = await subscriptionRow();
    expect(row).toMatchObject({
      // Строка остаётся активной: доступ живёт до конца оплаченного периода.
      status: 'active',
      auto_renew: false,
      telegram_cancel_state: 'cancelled',
      telegram_cancel_attempts: 1,
    });
    expect(row?.cancelled_at).not.toBeNull();

    // Отмена ≠ возврат: права те же, `is_active` тот же.
    const after = await me();
    expect(after.subscription.is_active).toBe(true);
    expect(after.subscription.expires_at).toBe(before.subscription.expires_at);
    expect(after.subscription.auto_renew).toBe(false);
    expect(typeof after.subscription.cancelled_at).toBe('string');
    expect(after.entitlements).toEqual(before.entitlements);
  });

  it('пишет события и метрики: одна отмена, ноль провалов, одна подписка без автопродления', async () => {
    await userWithSubscription();

    await cancel().expect(200);

    const counters = await metrics();
    expect(counters.subscription_cancel_total_24h).toBe(1);
    expect(counters.subscription_cancel_failed_24h).toBe(0);
    expect(counters.subscription_cancel_no_charge_id_24h).toBe(0);
    expect(counters.subscriptions_auto_renew_off).toBe(1);

    const event = await ctx.db.queryOne<{ props: Record<string, unknown> }>(
      `SELECT props FROM events WHERE name = 'subscription_cancelled' LIMIT 1`,
    );
    expect(event?.props).toMatchObject({ source: 'endpoint' });
  });

  it('charge_id берётся из последнего успешного платежа подписки, а не из первого', async () => {
    const id = await ensureUser();
    // Два платежа: старый и последний. В строке подписки — последний, как его
    // обновляет `upsertSubscription` при продлении.
    await ctx.db.query(
      `INSERT INTO payments (user_id, telegram_id, plan_code, total_amount,
                             telegram_payment_charge_id, status, processed, paid_at)
       VALUES ($1, $2, 'month_399', 399, 'charge-old', 'processed', true, now() - interval '60 days')`,
      [id, FICTIONAL_USER.id],
    );
    await ctx.db.query(
      `INSERT INTO payments (user_id, telegram_id, plan_code, total_amount,
                             telegram_payment_charge_id, status, processed, paid_at)
       VALUES ($1, $2, 'month_399', 399, 'charge-new', 'processed', true, now())`,
      [id, FICTIONAL_USER.id],
    );
    await ctx.db.query(
      `INSERT INTO subscriptions (user_id, plan, status, expires_at, telegram_payment_charge_id)
       VALUES ($1, 'month', 'active', now() + interval '30 days', 'charge-new')`,
      [id],
    );

    await cancel().expect(200);

    expect(telegram.starSubscriptionCancels).toEqual([
      { userId: Number(FICTIONAL_USER.id), chargeId: 'charge-new' },
    ]);
  });
});

describe('POST /subscription/cancel — отменять нечего', () => {
  it('повтор после успеха → 409 already_cancelled, второго вызова в Bot API нет', async () => {
    await userWithSubscription();

    await cancel('cancel-key-1').expect(200);

    const repeat = await cancel('cancel-key-2').expect(409);
    expect(repeat.body).toMatchObject({
      code: 'CONFLICT',
      details: { reason: 'already_cancelled' },
    });
    // Второй раз Telegram не дёргаем: отменять нечего.
    expect(telegram.starSubscriptionCancels).toHaveLength(1);
    expect((await subscriptionRow())?.telegram_cancel_attempts).toBe(1);
  });

  it('подписки нет → 409 no_active_subscription, вызова нет', async () => {
    await ensureUser();

    const response = await cancel().expect(409);
    expect(response.body).toMatchObject({
      code: 'CONFLICT',
      details: { reason: 'no_active_subscription' },
    });
    expect(telegram.starSubscriptionCancels).toHaveLength(0);
  });

  it('истёкшая подписка → 409 no_active_subscription', async () => {
    await userWithSubscription({ days: -1 });

    const response = await cancel().expect(409);
    expect(response.body).toMatchObject({ details: { reason: 'no_active_subscription' } });
    expect(telegram.starSubscriptionCancels).toHaveLength(0);
  });

  it('подписка, отменённая удалением аккаунта, → 409 no_active_subscription', async () => {
    const id = await userWithSubscription();
    await ctx.db.query(`UPDATE subscriptions SET status = 'cancelled' WHERE user_id = $1`, [id]);

    const response = await cancel().expect(409);
    expect(response.body).toMatchObject({ details: { reason: 'no_active_subscription' } });
  });

  it('без Idempotency-Key → 422 и ни одного вызова в Bot API', async () => {
    await userWithSubscription();

    const response = await cancel(null).expect(422);
    expect(response.body).toMatchObject({
      code: 'VALIDATION_FAILED',
      details: { field_errors: [{ field: 'Idempotency-Key' }] },
    });
    expect(telegram.starSubscriptionCancels).toHaveLength(0);
    // Ключ проверяется до любых изменений: подписка всё ещё продлится.
    expect((await subscriptionRow())?.auto_renew).toBe(true);
  });
});

describe('POST /subscription/cancel — Telegram не подтвердил', () => {
  it('ok:false → 502 telegram_error, failed, событие и метрика; джоб повторяет → cancelled', async () => {
    telegram.starCancelOutcome = 'failed';
    await userWithSubscription();

    const response = await cancel().expect(502);
    expect(response.body).toMatchObject({
      code: 'INTERNAL',
      details: { reason: 'telegram_error' },
    });

    const row = await subscriptionRow();
    expect(row).toMatchObject({
      status: 'active',
      auto_renew: true,
      telegram_cancel_state: 'failed',
      telegram_cancel_attempts: 1,
    });
    // Пока Bot API не подтвердил — «отменено» в `/me` не пишем.
    const afterFailure = await me();
    expect(afterFailure.subscription.auto_renew).toBe(true);
    expect(afterFailure.subscription.is_active).toBe(true);

    const event = await ctx.db.queryOne<{ props: { code?: string; source?: string } }>(
      `SELECT props FROM events WHERE name = 'subscription_cancel_failed' LIMIT 1`,
    );
    expect(event?.props).toMatchObject({ code: 'telegram_error', source: 'endpoint' });

    const failedCounters = await metrics();
    expect(failedCounters.subscription_cancel_failed_24h).toBe(1);
    expect(failedCounters.subscription_cancel_total_24h).toBe(0);
    expect(failedCounters.subscriptions_cancelled_pending_telegram).toBe(1);

    // Ночной джоб повторяет ту же отмену: окно и лимит — как у `DELETE /me`.
    telegram.starCancelOutcome = 'cancelled';
    await ctx.db.query(`UPDATE subscriptions SET telegram_cancel_last_at = now() - interval '2 hours'`);

    const job = await runRetentionJob();
    expect(job).toMatchObject({ telegram_cancel_retried: 1, telegram_cancel_cancelled: 1 });

    const cancelled = await subscriptionRow();
    expect(cancelled).toMatchObject({ auto_renew: false, telegram_cancel_state: 'cancelled' });
    expect(cancelled?.cancelled_at).not.toBeNull();

    // И только теперь `/me` честно говорит «не продлится».
    const afterRetry = await me();
    expect(afterRetry.subscription.auto_renew).toBe(false);
    expect(afterRetry.subscription.is_active).toBe(true);
  });

  it('таймаут → 502 timeout, состояние failed', async () => {
    telegram.starCancelOutcome = 'timeout';
    await userWithSubscription();

    const response = await cancel().expect(502);
    expect(response.body).toMatchObject({ details: { reason: 'timeout' } });
    expect((await subscriptionRow())?.telegram_cancel_state).toBe('failed');
  });

  it('нет charge_id → 502 no_charge_id и отдельный счётчик «наш дефект»', async () => {
    await userWithSubscription({ chargeId: null });

    const response = await cancel().expect(502);
    expect(response.body).toMatchObject({
      code: 'INTERNAL',
      details: { reason: 'no_charge_id' },
    });

    const row = await subscriptionRow();
    // Повторять нечего: charge_id не появится сам, поэтому сразу `gave_up`.
    expect(row).toMatchObject({
      auto_renew: true,
      telegram_cancel_state: 'gave_up',
      telegram_cancel_attempts: 1,
    });
    expect(row?.cancelled_at).toBeNull();

    const counters = await metrics();
    expect(counters.subscription_cancel_no_charge_id_24h).toBe(1);
    expect(counters.subscription_cancel_failed_24h).toBe(1);
    expect(counters.subscription_cancel_total_24h).toBe(0);
  });

  it('после пяти неудач (gave_up) вызова нет: сразу 502', async () => {
    await userWithSubscription({ cancelState: 'gave_up', cancelAttempts: 5 });

    const response = await cancel().expect(502);
    expect(response.body).toMatchObject({ details: { reason: 'telegram_error' } });
    expect(telegram.starSubscriptionCancels).toHaveLength(0);
  });

  it('повторное нажатие после 502 пробует сразу, не дожидаясь джоба', async () => {
    telegram.starCancelOutcome = 'failed';
    await userWithSubscription();
    await cancel('key-1').expect(502);

    telegram.starCancelOutcome = 'cancelled';
    await cancel('key-2').expect(200);

    expect(telegram.starSubscriptionCancels).toHaveLength(2);
    expect((await subscriptionRow())?.auto_renew).toBe(false);
  });
});

describe('POST /subscription/cancel — тестовый тариф test_1', () => {
  it('отмена проходит так же, повтор → 409 already_cancelled', async () => {
    // `test_1` — тестовая подписка владельца за 1 ⭐ (30 дней: Bot API не
    // принимает других периодов у звёздных подписок).
    await userWithSubscription({
      planCode: 'test_1',
      plan: 'month',
      days: 30,
      isTest: true,
      chargeId: 'charge-test-1',
    });

    const response = await cancel('test-cancel-1').expect(200);
    expect(response.body).toMatchObject({ status: 'cancelled', auto_renew: false });
    expect(telegram.starSubscriptionCancels).toEqual([
      { userId: Number(FICTIONAL_USER.id), chargeId: 'charge-test-1' },
    ]);

    const repeat = await cancel('test-cancel-2').expect(409);
    expect(repeat.body).toMatchObject({ details: { reason: 'already_cancelled' } });

    // Доступ по тестовой подписке тоже остаётся до конца периода.
    const after = await me();
    expect(after.subscription).toMatchObject({ plan: 'month', is_active: true, auto_renew: false });
    expect(after.subscription.cancelled_at).not.toBeNull();
  });
});

describe('GET /me — состояние автопродления', () => {
  it('до отмены: auto_renew true, cancelled_at null; после: false и дата', async () => {
    await userWithSubscription();

    const before = await me();
    expect(before.subscription.auto_renew).toBe(true);
    expect(before.subscription.cancelled_at ?? null).toBeNull();

    await cancel().expect(200);

    const after = await me();
    expect(after.subscription.auto_renew).toBe(false);
    expect(typeof after.subscription.cancelled_at).toBe('string');
    // Даты в ответе — ISO, а не «что-то похожее на дату».
    expect(Number.isNaN(Date.parse(after.subscription.cancelled_at ?? ''))).toBe(false);
    expect(Number.isNaN(Date.parse(after.subscription.expires_at ?? ''))).toBe(false);
  });

  it('без подписки: plan none, auto_renew false, cancelled_at null', async () => {
    await ensureUser();

    const body = await me();
    expect(body.subscription).toMatchObject({ plan: 'none', is_active: false, auto_renew: false });
    expect(body.subscription.cancelled_at ?? null).toBeNull();
  });
});

describe('DELETE /me после отмены из приложения', () => {
  it('удаление проходит, второго вызова editUserStarSubscription нет', async () => {
    await userWithSubscription();
    await cancel().expect(200);
    expect(telegram.starSubscriptionCancels).toHaveLength(1);

    await request(ctx.app.getHttpServer())
      .delete('/api/v1/me')
      .set(INIT_DATA_HEADER, initDataFor())
      .expect(204);

    // Поведение `DELETE /me` не изменилось: данные удалены.
    expect(await ctx.db.query(`SELECT 1 FROM users`)).toHaveLength(0);

    // Автопродление уже погашено — второй вызов Bot API не нужен.
    expect(telegram.starSubscriptionCancels).toHaveLength(1);

    const row = await subscriptionRow();
    expect(row).toMatchObject({ status: 'cancelled', telegram_cancel_state: 'cancelled' });
    expect(row?.auto_renew).toBe(false);

    // Строка подписки пережила удаление, но обезличена: `user_id` обнулён,
    // `cancelled_at` и `expires_at` остались для бухучёта и возвратов.
    const anonymized = await ctx.db.queryOne<{ user_id: string | null; cancelled_at: Date | null }>(
      `SELECT user_id::text AS user_id, cancelled_at FROM subscriptions`,
    );
    expect(anonymized?.user_id).toBeNull();
    expect(anonymized?.cancelled_at).not.toBeNull();
  });
});
