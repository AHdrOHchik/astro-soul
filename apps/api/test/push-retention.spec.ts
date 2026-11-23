import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { EngagementRepository } from '../src/modules/engagement/engagement.repository';
import { PushTextCache, buildPushMessage } from '../src/modules/engagement/push-message';
import { UsersRepository } from '../src/modules/users/users.repository';
import { createTestContext, truncateAll, type TestContext } from './test-app';
import { FICTIONAL_USER } from './test-env';

/**
 * Долги 8.5 из итерации 38 (контракт 1.6.14): журнал пушей, кэш текста и
 * чистка `push_runs`/`share_cards`.
 *
 *   • `push_log.sent` разделяет «ушло» и «умерло между заявкой и отправкой».
 *     Без этого различия потеря пуша не видна ни в метрике, ни в алерте:
 *     строка есть, `error` пуст, человек сообщения не получил.
 *   • `PushTextCache` живёт один прогон: текст на 96 комбинаций считается
 *     один раз, но вчерашний текст не переезжает в сегодня.
 *   • Чистка: агрегаты циклов старше 30 дней не нужны, карточки с открытиями
 *     не удаляются вовсе — ссылки в чужих переписках должны работать.
 */

let ctx: TestContext;
let users: UsersRepository;
let repo: EngagementRepository;

const JOBS_SECRET = 'test-jobs-secret-round39';

beforeAll(async () => {
  // Джобы защищены секретом; в тестах он вымышленный и задаётся здесь, чтобы
  // спека не зависела от порядка прогона других файлов.
  ctx = await createTestContext({ env: { INTERNAL_JOB_SECRET: JOBS_SECRET } });
  users = ctx.app.get(UsersRepository);
  repo = ctx.app.get(EngagementRepository);
});

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  await truncateAll(ctx.db);
});

async function makeUser(): Promise<string> {
  const result = await users.ensureUser({
    telegramUserId: BigInt(FICTIONAL_USER.id),
    languageCode: 'ru',
  });

  return result.userId;
}

describe('журнал пушей: заявка и отправка', () => {
  it('заявка пишется как «не отправлено»', async () => {
    const userId = await makeUser();

    expect(await repo.claimPush(userId, '2026-11-16')).toBe(true);

    const row = await ctx.db.queryOne<{ sent: boolean; error: string | null }>(
      `SELECT sent, error FROM push_log WHERE user_id = $1`,
      [userId],
    );

    expect(row?.sent).toBe(false);
    expect(row?.error).toBeNull();
  });

  it('вторая заявка за те же сутки не создаёт строку', async () => {
    const userId = await makeUser();

    await repo.claimPush(userId, '2026-11-16');

    // Идемпотентность держится на уникальном индексе, а не на памяти процесса.
    expect(await repo.claimPush(userId, '2026-11-16')).toBe(false);
    expect(await ctx.db.query<{ total: string }>(`SELECT count(*)::text AS total FROM push_log`)).toEqual([
      { total: '1' },
    ]);
  });

  it('итог отправки: успех поднимает `sent`, отказ — нет', async () => {
    const userId = await makeUser();
    const other = await users.ensureUser({ telegramUserId: 777_000_333n, languageCode: 'ru' });

    await repo.claimPush(userId, '2026-11-16');
    await repo.finishPush(userId, '2026-11-16', 'daily_forecast', null);

    await repo.claimPush(other.userId, '2026-11-16');
    await repo.finishPush(other.userId, '2026-11-16', 'daily_forecast', 'blocked');

    const rows = await ctx.db.query<{ user_id: string; sent: boolean; error: string | null }>(
      `SELECT user_id, sent, error FROM push_log ORDER BY sent_at`,
    );

    expect(rows).toEqual(
      expect.arrayContaining([
        { user_id: userId, sent: true, error: null },
        { user_id: other.userId, sent: false, error: 'blocked' },
      ]),
    );
  });
});

describe('pushLogTotals24h', () => {
  it('считает отправленные, потерянные и неуспешные по-разному', async () => {
    const prefix = `9000000000${String(Date.now()).slice(-6)}`;

    // Пять строк: успех, «умер между заявкой и отправкой», blocked,
    // chat_not_found и настоящая ошибка Bot API.
    const cases: readonly { sent: boolean; error: string | null }[] = [
      { sent: true, error: null },
      { sent: false, error: null },
      { sent: false, error: 'blocked' },
      { sent: false, error: 'chat_not_found' },
      { sent: false, error: 'Bad Request: message is too long' },
    ];

    for (const [index, item] of cases.entries()) {
      const user = await users.ensureUser({
        telegramUserId: BigInt(prefix + String(index).padStart(2, '0')),
        languageCode: 'ru',
      });
      await ctx.db.query(
        `INSERT INTO push_log (user_id, local_date, kind, sent, error, sent_at)
         VALUES ($1, '2026-11-16'::date, 'daily_forecast', $2, $3, now() - interval '1 hour')`,
        [user.userId, item.sent, item.error],
      );
    }

    const totals = await repo.pushLogTotals24h();

    expect(totals).toEqual({ sent: 1, failed: 1, claimedNotSent: 1 });
  });

  it('строка, записанная до 0036 (sent = true с ошибкой), считается провалом', async () => {
    // Миграция дала старым строкам `DEFAULT true`: `sent` у них не значит
    // «ушло», а `error` значит «не ушло». Метрика должна читать именно так,
    // иначе в день миграции провалы исчезли бы из алерта, а отправки — выросли.
    const userId = await makeUser();

    await ctx.db.query(
      `INSERT INTO push_log (user_id, local_date, kind, sent, error)
       VALUES ($1, current_date, 'daily_forecast', true, 'telegram_failed')`,
      [userId],
    );

    expect(await repo.pushLogTotals24h()).toEqual({ sent: 0, failed: 1, claimedNotSent: 0 });
  });

  it('старые строки не попадают в суточные итоги', async () => {
    const userId = await makeUser();

    await ctx.db.query(
      `INSERT INTO push_log (user_id, local_date, kind, sent, error, sent_at)
       VALUES ($1, '2026-11-10'::date, 'daily_forecast', false, NULL, now() - interval '30 hours')`,
      [userId],
    );

    expect(await repo.pushLogTotals24h()).toEqual({ sent: 0, failed: 0, claimedNotSent: 0 });
  });
});

describe('чистка push_runs и share_cards', () => {
  function internalJob(job: string): request.Test {
    return request(ctx.app.getHttpServer())
      .post(`/api/v1/internal/jobs/run?job=${job}`)
      .set('X-Jobs-Secret', JOBS_SECRET);
  }

  it('удаляет агрегаты старше 30 дней и пустые карточки, открытые не трогает', async () => {
    await ctx.db.query(
      `INSERT INTO push_runs (started_at) VALUES (now() - interval '31 days'), (now() - interval '29 days')`,
    );

    await ctx.db.query(
      `INSERT INTO share_cards (kind, content_hash, short_id, storage_key, bytes, width, height, created_at, last_opened_at)
       VALUES
         ('day', 'hash-old-unopened', 'sold0001', 'k1', 10, 100, 100, now() - interval '31 days', NULL),
         ('day', 'hash-old-opened',   'sold0002', 'k2', 10, 100, 100, now() - interval '31 days', now() - interval '2 days'),
         ('day', 'hash-new',          'snew0003', 'k3', 10, 100, 100, now() - interval '1 day',  NULL)`,
    );

    const response = await internalJob('push_share_retention').expect(202);

    expect(response.body.push_runs_purged).toBe(1);
    expect(response.body.share_cards_purged).toBe(1);

    // Точное число строк не проверяем: сам прогон джоба пишет свой агрегат.
    // Проверяем смысл — «старше 30 дней нет, 29-дневный на месте».
    const old = await ctx.db.queryOne<{ total: string }>(
      `SELECT count(*)::text AS total FROM push_runs
        WHERE started_at < now() - interval '30 days'`,
    );
    expect(old?.total).toBe('0');

    const kept = await ctx.db.queryOne<{ total: string }>(
      `SELECT count(*)::text AS total FROM push_runs
        WHERE started_at > now() - interval '30 days'
          AND started_at < now() - interval '10 days'`,
    );
    expect(kept?.total).toBe('1');

    const cards = await ctx.db.query<{ short_id: string }>(
      `SELECT short_id FROM share_cards ORDER BY short_id`,
    );
    expect(cards.map((card) => card.short_id)).toEqual(['snew0003', 'sold0002']);
  });

  it('повторный прогон ничего не удаляет', async () => {
    await internalJob('push_share_retention').expect(202);

    const again = await internalJob('push_share_retention').expect(202);
    expect(again.body.push_runs_purged).toBe(0);
    expect(again.body.share_cards_purged).toBe(0);
  });
});

describe('PushTextCache', () => {
  it('считает текст один раз на пару «знак + фаза»', () => {
    const cache = new PushTextCache();
    const first = cache.build('2026-11-16', { sign: 'Рыбы', phase: 'полнолуние' });
    const second = cache.build('2026-11-16', { sign: 'Рыбы', phase: 'полнолуние' });

    // Один и тот же объект: значит, экранирование и обрезка не повторялись.
    expect(second).toBe(first);
    expect(cache.size).toBe(1);
  });

  it('разные сутки — разные записи: вчерашний текст не переезжает', () => {
    const cache = new PushTextCache();

    cache.build('2026-11-15', { sign: 'Рыбы', phase: 'полнолуние' });
    cache.build('2026-11-16', { sign: 'Рыбы', phase: 'полнолуние' });

    expect(cache.size).toBe(2);
  });

  it('текст из кэша побитово равен собранному напрямую', () => {
    const cache = new PushTextCache();
    const direct = buildPushMessage({ sign: 'Рыбы', phase: 'растущая Луна' });
    const cached = cache.build('2026-11-16', { sign: 'Рыбы', phase: 'растущая Луна' });

    expect(cached).toEqual(direct);
  });

  it('кэш не общий между прогонами', () => {
    const first = new PushTextCache();
    first.build('2026-11-16', { sign: 'Рыбы', phase: 'полнолуние' });

    // Новый прогон — новый кэш: правка констант и деплой должны быть видны.
    expect(new PushTextCache().size).toBe(0);
  });
});
