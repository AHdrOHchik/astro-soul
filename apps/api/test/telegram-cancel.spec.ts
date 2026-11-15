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
 * Задача A итерации 12: `DELETE /me` отменяет автопродление в Telegram.
 *
 * Локальная `subscriptions.cancelled` подписку в Telegram не отменяет — звёзды
 * списывались за следующий период уже после удаления данных. Вызов
 * `editUserStarSubscription(is_canceled: true)` идёт **до** транзакции удаления,
 * а его ошибка удаление не блокирует (152-ФЗ: удаление не зависит от
 * доступности чужого API).
 */

const ADMIN_TG_ID = String(FICTIONAL_USER.id);
const JOBS_SECRET = 'test-jobs-secret-0123456789';
const CHARGE_ID = 'charge-sub-cancel-1';

/** Поля метрик, которые проверяет этот файл. */
interface MetricsBody {
  readonly subscription_cancel_failed_30d: number;
  readonly subscriptions_cancelled_pending_telegram: number;
}

/** Поля ответа джоба, которые проверяет этот файл. */
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
    env: { ADMIN_TG_ID, INTERNAL_JOB_SECRET: JOBS_SECRET },
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

/** Пользователь с оплаченной годовой подпиской: платёж + строка подписки. */
async function userWithSubscription(chargeId = CHARGE_ID): Promise<string> {
  await request(ctx.app.getHttpServer())
    .get('/api/v1/me')
    .set(INIT_DATA_HEADER, initDataFor())
    .expect(200);

  const id = userId();

  await ctx.db.query(
    `INSERT INTO payments (user_id, telegram_id, plan_code, total_amount,
                           telegram_payment_charge_id, status, processed, paid_at)
     VALUES ($1, $2, 'year_2990', 2990, $3, 'processed', true, now())`,
    [id, FICTIONAL_USER.id, chargeId],
  );
  await ctx.db.query(
    `INSERT INTO subscriptions (user_id, plan, status, expires_at, telegram_payment_charge_id)
     VALUES ($1, 'year', 'active', now() + interval '365 days', $2)`,
    [id, chargeId],
  );

  return id;
}

async function deleteMe(): Promise<void> {
  await request(ctx.app.getHttpServer())
    .delete('/api/v1/me')
    .set(INIT_DATA_HEADER, initDataFor())
    .expect(204);
}

async function subscription(): Promise<{
  status: string;
  user_id: string | null;
  telegram_cancel_state: string;
  telegram_cancel_attempts: number;
} | null> {
  return ctx.db.queryOne(
    `SELECT status::text AS status, user_id::text AS user_id,
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

describe('DELETE /me — отмена автопродления в Telegram', () => {
  it('успех: Bot API получил пару (telegram_id, charge_id), состояние cancelled', async () => {
    await userWithSubscription();

    await deleteMe();

    expect(telegram.starSubscriptionCancels).toEqual([
      { userId: Number(FICTIONAL_USER.id), chargeId: CHARGE_ID },
    ]);

    const row = await subscription();
    expect(row).toMatchObject({
      status: 'cancelled',
      user_id: null,
      telegram_cancel_state: 'cancelled',
      telegram_cancel_attempts: 1,
    });

    // Локальное удаление при этом выполнено целиком.
    expect(await ctx.db.query(`SELECT 1 FROM users`)).toHaveLength(0);
    expect(await ctx.db.query(`SELECT 1 FROM charts`)).toHaveLength(0);
  });

  it('Telegram ответил ok:false: удаление всё равно прошло, состояние failed + событие', async () => {
    telegram.starCancelOutcome = 'failed';
    const id = await userWithSubscription();

    await deleteMe();

    // 400 CHARGE_ID_INVALID — не повод держать ПДн.
    expect(await ctx.db.query(`SELECT 1 FROM users`)).toHaveLength(0);
    for (const table of ['payments', 'subscriptions', 'entitlements', 'events'] as const) {
      const row = await ctx.db.queryOne<{ count: string }>(
        `SELECT count(*)::text AS count FROM ${table} WHERE user_id = $1`,
        [id],
      );
      expect(Number(row?.count ?? '0'), `${table}.user_id`).toBe(0);
    }

    const row = await subscription();
    expect(row).toMatchObject({ telegram_cancel_state: 'failed', telegram_cancel_attempts: 1 });

    const event = await ctx.db.queryOne<{ props: { code?: string } }>(
      `SELECT props FROM events WHERE name = 'subscription_cancel_failed'
        ORDER BY created_at DESC LIMIT 1`,
    );
    expect(event?.props.code).toBe('telegram_error');
  });

  it('таймаут Telegram: то же самое — failed, удаление выполнено', async () => {
    telegram.starCancelOutcome = 'timeout';
    await userWithSubscription();

    await deleteMe();

    expect(await ctx.db.query(`SELECT 1 FROM users`)).toHaveLength(0);
    expect((await subscription())?.telegram_cancel_state).toBe('failed');
    const event = await ctx.db.queryOne<{ props: { code?: string } }>(
      `SELECT props FROM events WHERE name = 'subscription_cancel_failed' LIMIT 1`,
    );
    expect(event?.props.code).toBe('timeout');
  });

  it('исключение в клиенте Bot API не откатывает транзакцию удаления', async () => {
    // Порядок «сначала Telegram, потом транзакция»: если вызов поставить после
    // удаления и дать ему бросить, этот тест упал бы на пустой БД.
    telegram.starCancelOutcome = 'throws';
    await userWithSubscription();

    await deleteMe();

    expect(await ctx.db.query(`SELECT 1 FROM users`)).toHaveLength(0);
    expect((await subscription())?.telegram_cancel_state).toBe('failed');
  });

  it('подписки нет — вызова нет вовсе (счётчик 0)', async () => {
    await request(ctx.app.getHttpServer())
      .get('/api/v1/me')
      .set(INIT_DATA_HEADER, initDataFor())
      .expect(200);

    await deleteMe();

    expect(telegram.starSubscriptionCancels).toHaveLength(0);
    expect(await ctx.db.query(`SELECT 1 FROM users`)).toHaveLength(0);
    // Состояния «none» в строке нет: строки подписки тоже нет.
    expect(await ctx.db.query(`SELECT 1 FROM subscriptions`)).toHaveLength(0);
  });

  it('отменённая подписка: состояние повтора не затирается удалением', async () => {
    await request(ctx.app.getHttpServer())
      .get('/api/v1/me')
      .set(INIT_DATA_HEADER, initDataFor())
      .expect(200);
    const id = userId();
    // Строка уже отменена (например, возвратом) и ждёт повтора в Telegram:
    // новый `DELETE /me` не должен сбросить `failed` в `none`, иначе повтор
    // из ночного джоба потеряется.
    await ctx.db.query(
      `INSERT INTO subscriptions
         (user_id, plan, status, expires_at, telegram_cancel_state,
          telegram_cancel_attempts, telegram_cancel_last_at)
       VALUES ($1, 'year', 'cancelled', now(), 'failed', 2, now() - interval '2 hours')`,
      [id],
    );

    await deleteMe();

    const row = await subscription();
    expect(row).toMatchObject({ telegram_cancel_state: 'failed', telegram_cancel_attempts: 2 });
    expect(telegram.starSubscriptionCancels).toHaveLength(0);
  });

  it('подписка без charge_id: no_charge_id, вызова нет, состояние failed', async () => {
    await request(ctx.app.getHttpServer())
      .get('/api/v1/me')
      .set(INIT_DATA_HEADER, initDataFor())
      .expect(200);
    const id = userId();
    // Строка есть, а пары для Bot API нет: звать некого.
    await ctx.db.query(
      `INSERT INTO subscriptions (user_id, plan, status, expires_at)
       VALUES ($1, 'year', 'active', now() + interval '365 days')`,
      [id],
    );

    await deleteMe();

    expect(telegram.starSubscriptionCancels).toEqual([{ userId: null, chargeId: null }]);
    expect((await subscription())?.telegram_cancel_state).toBe('failed');
    const event = await ctx.db.queryOne<{ props: { code?: string } }>(
      `SELECT props FROM events WHERE name = 'subscription_cancel_failed' LIMIT 1`,
    );
    expect(event?.props.code).toBe('no_charge_id');
  });
});

describe('повтор отмены автопродления ночным джобом', () => {
  async function failedSubscription(patch: string): Promise<void> {
    await userWithSubscription();
    telegram.starCancelOutcome = 'failed';
    await deleteMe();
    await ctx.db.query(`UPDATE subscriptions SET ${patch}`);
  }

  it('failed → cancelled за одну попытку, второй прогон не вызывает Telegram', async () => {
    await failedSubscription(`telegram_cancel_last_at = now() - interval '2 hours'`);
    telegram.starCancelOutcome = 'cancelled';
    telegram.starSubscriptionCancels.length = 0;

    const first = await runRetentionJob();
    expect(first).toMatchObject({ telegram_cancel_retried: 1, telegram_cancel_cancelled: 1 });
    expect(telegram.starSubscriptionCancels).toHaveLength(1);
    expect((await subscription())?.telegram_cancel_state).toBe('cancelled');

    const second = await runRetentionJob();
    expect(second.telegram_cancel_retried).toBe(0);
    expect(telegram.starSubscriptionCancels).toHaveLength(1);
  });

  it('не чаще раза в час: свежая неудача в этом прогоне не повторяется', async () => {
    await failedSubscription(`telegram_cancel_last_at = now() - interval '10 minutes'`);

    const result = await runRetentionJob();

    expect(result.telegram_cancel_retried).toBe(0);
    expect(telegram.starSubscriptionCancels).toHaveLength(1);
  });

  it('gave_up после пятой неудачи, дальше не пробует и метрика не растёт', async () => {
    await failedSubscription(
      `telegram_cancel_last_at = now() - interval '2 hours', telegram_cancel_attempts = 4`,
    );

    const result = await runRetentionJob();
    expect(result).toMatchObject({ telegram_cancel_retried: 1, telegram_cancel_gave_up: 1 });

    const row = await subscription();
    expect(row).toMatchObject({ telegram_cancel_state: 'gave_up', telegram_cancel_attempts: 5 });

    const again = await runRetentionJob();
    expect(again.telegram_cancel_retried).toBe(0);
  });
});

describe('метрики отмены автопродления', () => {
  async function metrics(): Promise<MetricsBody> {
    const response = await request(ctx.app.getHttpServer())
      .get('/api/v1/admin/metrics')
      .set(INIT_DATA_HEADER, initDataFor())
      .expect(200);
    const body: unknown = response.body;
    return body as MetricsBody;
  }

  it('subscription_cancel_failed_30d и subscriptions_cancelled_pending_telegram растут', async () => {
    await userWithSubscription();
    telegram.starCancelOutcome = 'failed';

    await deleteMe();

    const after = await metrics();
    expect(after.subscription_cancel_failed_30d).toBe(1);
    expect(after.subscriptions_cancelled_pending_telegram).toBe(1);

    // Повтор удался — «ждут повтора» снова ноль, а число отказов остаётся:
    // это история, а не очередь.
    telegram.starCancelOutcome = 'cancelled';
    await ctx.db.query(`UPDATE subscriptions SET telegram_cancel_last_at = now() - interval '2 hours'`);
    await runRetentionJob();

    const retried = await metrics();
    expect(retried.subscription_cancel_failed_30d).toBe(1);
    expect(retried.subscriptions_cancelled_pending_telegram).toBe(0);
  });
});
