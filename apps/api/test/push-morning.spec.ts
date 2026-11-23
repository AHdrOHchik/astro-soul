import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { INIT_DATA_HEADER } from '../src/modules/auth/init-data';
import { EngagementService, type PushRunOptions } from '../src/modules/engagement/engagement.service';
import {
  FORBIDDEN_EMOJI,
  PHASE_EMOJI,
  PUSH_INVITE,
  PUSH_MAX_CHARS,
  PUSH_OFF_CALLBACK,
  PUSH_OFF_TEXT,
  PUSH_OPEN_TEXT,
  buildPushMessage,
} from '../src/modules/engagement/push-message';
import { MOON_ADVICE, MOON_PHASES } from '../src/modules/share/share.service';
import { forbiddenTopicIn } from '../src/modules/reports/validators';
import { PresenceService } from '../src/modules/users/presence.service';
import { TelegramWebhookService } from '../src/modules/telegram/telegram-webhook.service';
import { EngagementRepository } from '../src/modules/engagement/engagement.repository';
import { createTestContext, truncateAll, type TestContext } from './test-app';
import { signInitData } from './init-data-fixture';
import { FICTIONAL_USER, TEST_BOT_TOKEN, TEST_WEBHOOK_SECRET } from './test-env';
import { makeFakeAstro } from './fake-astro';
import { makeFakeTelegram, type FakeTelegram } from './fake-telegram';

/**
 * Утренний пуш 08:00 по поясу рождения (итерация 38, контракт 1.6.13).
 *
 * Что проверяется и почему именно так:
 *
 *   • **окно 08:00–08:04** — не «час пуша», а пять минут. 07:59, 08:05 и 09:00
 *     не отправляют ничего: пропущенное окно не догоняется;
 *   • **ровно один пуш в местные сутки** — `push_log` уникален, второй прогон
 *     получает `duplicate_prevented`, а не второе «доброе утро»;
 *   • **пояс**, а не UTC: `Asia/Novosibirsk` даёт другую местную дату, а
 *     `Europe/Berlin` в ночь перехода летнего времени — ровно одно сообщение;
 *   • **согласие** — `push_enabled`: без него не шлём, 403 снимает его сам;
 *   • **текст** — 96 комбинаций «8 фаз × 12 знаков», ≤ 200 символов, без
 *     запрещённых эмодзи, чисел и тем;
 *   • **ошибки Bot API** — 403/400 `chat not found`/429/5xx ведут себя
 *     по-разному, и это видно в счётчиках, а не только в логах.
 */

const MOSCOW_OFFSET_MS = 3 * 60 * 60 * 1000;
const NOVOSIBIRSK_OFFSET_MS = 7 * 60 * 60 * 1000;

const BIRTH_MOSCOW = {
  birth_date: '1994-05-17',
  birth_time: '14:20',
  time_precision: 'exact',
  birth_place: { name: 'Москва', country: 'RU', lat: 55.7558, lon: 37.6173, tz: 'Europe/Moscow' },
  consent: { accepted: true, version: '2026-11-10' },
};

function birthIn(tz: string): Record<string, unknown> {
  return {
    ...BIRTH_MOSCOW,
    birth_place: { ...BIRTH_MOSCOW.birth_place, tz },
  };
}

/** «Сейчас» по Москве в заданную минуту суток — тесты не подменяют часы ОС. */
function atMoscow(hour: number, minute = 0): Date {
  const local = new Date(Date.now() + MOSCOW_OFFSET_MS);
  return new Date(
    Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), hour, minute, 0) -
      MOSCOW_OFFSET_MS,
  );
}

/** Местная дата в поясе со сдвигом (только для поясов без перехода времени). */
function localDate(at: Date, offsetMs: number): string {
  return new Date(at.getTime() + offsetMs).toISOString().slice(0, 10);
}

interface Fixture {
  readonly chartId: string;
  readonly userId: string;
  readonly telegramId: number;
}

let ctx: TestContext;
let telegram: FakeTelegram;
let engagement: EngagementService;

/** Telegram id разных «людей»: у каждого своя карта и свой чат. */
let nextTelegramId = 777_100_001;

function initDataFor(telegramId: number): string {
  return signInitData({
    botToken: TEST_BOT_TOKEN,
    user: { ...FICTIONAL_USER, id: telegramId },
  });
}

beforeAll(async () => {
  telegram = makeFakeTelegram();
  ctx = await createTestContext({
    astro: makeFakeAstro(),
    telegram,
    env: {
      PUSH_ENABLED: '1',
      MINI_APP_URL: 'https://app.astro-soul.test/mini',
      ADMIN_TG_ID: String(FICTIONAL_USER.id),
    },
  });
  engagement = ctx.app.get(EngagementService);
});

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  await truncateAll(ctx.db);
  // `push_runs` чистим руками: у таблицы нет FK на `users`, CASCADE до неё не
  // доходит, а счётчики `/health` и метрик не должны переживать тест.
  await ctx.db.query(`DELETE FROM push_runs`);
  await ctx.db.query(`DELETE FROM push_log`);
  await ctx.db.query(`DELETE FROM events WHERE name = 'push_disabled'`);
  telegram.pushes.length = 0;
  telegram.messages.length = 0;
  telegram.callbackAnswers.length = 0;
  telegram.pushOutcome = 'sent';
  telegram.pushQueue.length = 0;
  telegram.pushRetryAfter = 1;
  // Присутствие живёт в памяти процесса: без сброса «минута» одного теста
  // пережила бы `truncateAll` и второй тест не увидел бы свежий `last_seen_at`.
  ctx.app.get(PresenceService).reset();
});

/** Пользователь с картой — через тот же API, что и в проде. */
async function userWithChart(tz = 'Europe/Moscow', telegramId?: number): Promise<Fixture> {
  // Каждый вызов — свой человек: два `POST /charts` одним initData дали бы
  // две карты у одного пользователя, и рассылка взяла бы последнюю.
  nextTelegramId += 1;
  const id = telegramId ?? nextTelegramId;
  const response = await request(ctx.app.getHttpServer())
    .post('/api/v1/charts')
    .set(INIT_DATA_HEADER, initDataFor(id))
    .send(birthIn(tz))
    .expect(201);

  const user = await ctx.db.queryOne<{ id: string }>(`SELECT id FROM users WHERE telegram_id = $1`, [
    BigInt(id),
  ]);

  return { chartId: response.body.chart.chart_id as string, userId: user?.id ?? '', telegramId: id };
}

/**
 * Пояс карты меняем прямо в БД.
 *
 * `POST /charts` определяет пояс по координатам через geo-провайдер, а не
 * берёт `tz` из тела: тест «человек в Новосибирске» не должен зависеть от
 * каталога городов. Рассылке важно ровно то, что лежит в
 * `charts.data.chart.birth.place.tz`, — это и выставляем.
 */
async function setTz(fixture: Fixture, tz: string): Promise<void> {
  await ctx.db.query(
    `UPDATE charts SET data = jsonb_set(data, '{chart,birth,place,tz}', $2::jsonb) WHERE id = $1`,
    [fixture.chartId, JSON.stringify(tz)],
  );
}

/** Прогон без реальных пауз: окно проверяется по `at`, часы подменены. */
function optionsFor(at: Date): PushRunOptions {
  return { sleep: () => Promise.resolve(), sendGapMs: 0, retryDelayMs: 0, now: () => at };
}

async function run(at: Date): Promise<Awaited<ReturnType<EngagementService['runPush']>>> {
  return engagement.runPush(at, optionsFor(at));
}

describe('утренний пуш: получатели', () => {
  it('шлёт одно сообщение с кнопками «Открыть разбор дня» и «Отключить»', async () => {
    const fixture = await userWithChart();
    const at = atMoscow(8);

    const result = await run(at);

    expect(result.enabled).toBe(true);
    expect(result.sent).toBe(1);
    expect(telegram.pushes).toHaveLength(1);

    const push = telegram.pushes[0];
    expect(push?.text).toContain('Доброе утро.');
    expect(push?.text).toContain(PUSH_INVITE);
    expect(push?.text).not.toContain('http');

    const rows = push?.buttons ?? [];
    expect(rows[0]?.[0]?.text).toBe(PUSH_OPEN_TEXT);
    expect(rows[0]?.[0]?.webAppUrl).toBe('https://app.astro-soul.test/mini');
    expect(rows[1]?.[0]?.text).toBe(PUSH_OFF_TEXT);
    expect(rows[1]?.[0]?.callbackData).toBe(PUSH_OFF_CALLBACK);

    const log = await ctx.db.queryOne<{ local_date: string; error: string | null }>(
      `SELECT local_date::text AS local_date, error FROM push_log WHERE user_id = $1`,
      [fixture.userId],
    );
    expect(log?.local_date).toBe(localDate(at, MOSCOW_OFFSET_MS));
    expect(log?.error).toBeNull();
  });

  it('без согласия не шлёт: push_enabled = false', async () => {
    const fixture = await userWithChart();
    await ctx.db.query(`UPDATE users SET push_enabled = false WHERE id = $1`, [fixture.userId]);

    const result = await run(atMoscow(8));

    expect(result.sent).toBe(0);
    expect(result.candidates).toBe(0);
    expect(telegram.pushes).toHaveLength(0);
  });

  it('без карты не шлёт: человек есть, карты нет', async () => {
    const fixture = await userWithChart();
    await ctx.db.query(`DELETE FROM charts WHERE id = $1`, [fixture.chartId]);

    const result = await run(atMoscow(8));

    expect(result.sent).toBe(0);
    expect(telegram.pushes).toHaveLength(0);
  });

  it('карта без валидного пояса навсегда попадает в skipped_no_tz', async () => {
    await userWithChart();
    // Порт в базе испорчен: 08:00 по местному не вычислить.
    await ctx.db.query(
      `UPDATE charts SET data = jsonb_set(data, '{chart,birth,place,tz}', '"Москва/неверно"')`,
    );

    const result = await run(atMoscow(8));

    expect(result.sent).toBe(0);
    expect(result.skippedNoTz).toBe(1);
    expect(telegram.pushes).toHaveLength(0);
  });
});

describe('утренний пуш: окно 08:00–08:04', () => {
  it('07:59 — ещё не время', async () => {
    await userWithChart();

    const result = await run(atMoscow(7, 59));

    expect(result.sent).toBe(0);
    expect(telegram.pushes).toHaveLength(0);
  });

  it('08:00 — отправляем', async () => {
    await userWithChart();

    expect((await run(atMoscow(8, 0))).sent).toBe(1);
  });

  it('08:04 — последняя минута окна', async () => {
    await userWithChart();

    expect((await run(atMoscow(8, 4))).sent).toBe(1);
  });

  it('08:05 — окно закрылось, не отправляем', async () => {
    await userWithChart();

    expect((await run(atMoscow(8, 5))).sent).toBe(0);
  });

  it('09:00 — час опоздания не догоняется', async () => {
    await userWithChart();

    const result = await run(atMoscow(9, 0));

    expect(result.sent).toBe(0);
    expect(telegram.pushes).toHaveLength(0);
  });
});

describe('утренний пуш: идемпотентность и пояса', () => {
  it('два прогона в одну минуту — одно сообщение', async () => {
    const fixture = await userWithChart();
    const at = atMoscow(8);

    expect((await run(at)).sent).toBe(1);
    const second = await run(at);

    expect(second.sent).toBe(0);
    // Второй прогон уже не видит получателя: строка `push_log` есть, а выборка
    // идёт по «на эти сутки пуша не было». Это и есть защита, только дешёвая —
    // запрос не возвращает никого.
    expect(second.candidates).toBe(0);
    expect(telegram.pushes).toHaveLength(1);

    const rows = await ctx.db.query<{ total: string }>(
      `SELECT count(*)::text AS total FROM push_log WHERE user_id = $1`,
      [fixture.userId],
    );
    expect(rows[0]?.total).toBe('1');
  });

  it('claimPush: второй захват тех же местных суток возвращает false', async () => {
    const fixture = await userWithChart();
    const repository = ctx.app.get(EngagementRepository);
    const date = localDate(atMoscow(8), MOSCOW_OFFSET_MS);

    expect(await repository.claimPush(fixture.userId, date)).toBe(true);
    // Гонка двух тиков: уникальный ключ (user_id, local_date, kind) не даёт
    // второму процессу занять те же сутки. Это источник счётчика
    // `push_duplicate_prevented`.
    expect(await repository.claimPush(fixture.userId, date)).toBe(false);
  });

  it('второй запуск в ту же минуту ловит конфликт ключа, а не чужой флаг', async () => {
    const fixture = await userWithChart();

    // Строка уже есть — как будто первый прогон только что отправил.
    await ctx.db.query(
      `INSERT INTO push_log (user_id, local_date, kind) VALUES ($1, $2::date, 'daily_forecast')`,
      [fixture.userId, localDate(atMoscow(8), MOSCOW_OFFSET_MS)],
    );

    const result = await run(atMoscow(8));

    expect(result.candidates).toBe(0);
    expect(result.sent).toBe(0);
  });

  it('Asia/Novosibirsk: 08:00 местного — это 01:00 UTC, дата местная', async () => {
    const novosibirsk = await userWithChart();
    await setTz(novosibirsk, 'Asia/Novosibirsk');
    const moscow = await userWithChart();
    await setTz(moscow, 'Europe/Moscow');

    // 01:00 UTC = 08:00 по Новосибирску (UTC+7, перехода нет) и 04:00 по Москве.
    const at = new Date(`${localDate(new Date(), NOVOSIBIRSK_OFFSET_MS)}T01:00:00.000Z`);
    expect(at.getUTCHours()).toBe(1);

    const result = await run(at);

    // Пуш ушёл одному из двух: по UTC-часу не отправилось бы ни одному, по
    // московскому — тоже. Работает пояс карты.
    expect(result.sent).toBe(1);
    const log = await ctx.db.queryOne<{ local_date: string; user_id: string }>(
      `SELECT local_date::text AS local_date, user_id FROM push_log WHERE user_id = $1`,
      [novosibirsk.userId],
    );
    expect(log?.local_date).toBe(localDate(at, NOVOSIBIRSK_OFFSET_MS));
    expect(log?.user_id).toBe(novosibirsk.userId);
    expect(telegram.pushes).toHaveLength(1);
  });

  it('Europe/Berlin в ночь перехода на летнее время: ровно одно сообщение', async () => {
    const fixture = await userWithChart();
    await setTz(fixture, 'Europe/Berlin');

    // 29.03.2026: 02:00 CET → 03:00 CEST. 08:00 местного = 06:00 UTC.
    const before = new Date('2026-03-29T05:00:00.000Z'); // 07:00 местного (CET)
    const inWindow = new Date('2026-03-29T06:00:00.000Z'); // 08:00 местного (CEST)

    expect((await run(before)).sent).toBe(0);

    const result = await run(inWindow);

    expect(result.sent).toBe(1);
    expect(telegram.pushes).toHaveLength(1);

    // Повторный тик в том же окне дубля не даёт.
    expect((await run(inWindow)).sent).toBe(0);
    expect(telegram.pushes).toHaveLength(1);
  });

  it('смена пояса: следующий пуш идёт по новому поясу, история не пересчитывается', async () => {
    const fixture = await userWithChart();

    expect((await run(atMoscow(8))).sent).toBe(1);

    // Человек переехал: карта обновлена, пояс другой.
    await setTz(fixture, 'Asia/Novosibirsk');

    // 08:00 по Новосибирску на **следующие** местные сутки (01:00 UTC).
    const tomorrow = new Date(Date.now() + NOVOSIBIRSK_OFFSET_MS + 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    const nextDay = new Date(`${tomorrow}T01:00:00.000Z`);

    const result = await run(nextDay);

    expect(result.sent).toBe(1);
    // В журнале две строки: вчерашняя по Москве и следующая по Новосибирску.
    // Прошлое не пересчитывается: старые сутки остаются как были.
    const rows = await ctx.db.query<{ local_date: string }>(
      `SELECT local_date::text AS local_date FROM push_log WHERE user_id = $1 ORDER BY local_date`,
      [fixture.userId],
    );
    expect(rows.map((row) => row.local_date)).toEqual([
      localDate(atMoscow(8), MOSCOW_OFFSET_MS),
      tomorrow,
    ]);
    expect(telegram.pushes).toHaveLength(2);
  });

  it('не мешает тому, кто уже открывал приложение после 07:30 по своему поясу', async () => {
    const fixture = await userWithChart();
    const at = atMoscow(8);

    await ctx.db.query(`UPDATE users SET last_seen_at = $2::timestamptz WHERE id = $1`, [
      fixture.userId,
      atMoscow(7, 40),
    ]);

    const result = await run(at);

    expect(result.sent).toBe(0);
    expect(result.skippedSeen).toBe(1);
    expect(telegram.pushes).toHaveLength(0);
  });

  it('заход до 07:30 пушу не мешает', async () => {
    const fixture = await userWithChart();

    await ctx.db.query(`UPDATE users SET last_seen_at = $2::timestamptz WHERE id = $1`, [
      fixture.userId,
      atMoscow(7, 10),
    ]);

    expect((await run(atMoscow(8))).sent).toBe(1);
  });

  it('DELETE /me: человек удалён — следующий цикл его не видит', async () => {
    const fixture = await userWithChart();
    const at = atMoscow(8);

    await request(ctx.app.getHttpServer())
      .delete('/api/v1/me')
      .set(INIT_DATA_HEADER, initDataFor(fixture.telegramId))
      .expect(204);

    const result = await run(at);

    expect(result.candidates).toBe(0);
    expect(result.sent).toBe(0);
    const log = await ctx.db.query<{ total: string }>(`SELECT count(*)::text AS total FROM push_log`);
    expect(log[0]?.total).toBe('0');
  });
});

describe('утренний пуш: ошибки Bot API', () => {
  it('403 → push_enabled = false, ошибка в журнале, повтора нет', async () => {
    const fixture = await userWithChart();
    telegram.pushOutcome = 'blocked';

    const result = await run(atMoscow(8));

    expect(result.blocked).toBe(1);
    expect(result.sent).toBe(0);
    expect(telegram.pushes).toHaveLength(1);

    const user = await ctx.db.queryOne<{ push_enabled: boolean }>(
      `SELECT push_enabled FROM users WHERE id = $1`,
      [fixture.userId],
    );
    expect(user?.push_enabled).toBe(false);

    const log = await ctx.db.queryOne<{ error: string | null }>(
      `SELECT error FROM push_log WHERE user_id = $1`,
      [fixture.userId],
    );
    expect(log?.error).toBe('blocked');
  });

  it('400 chat not found → тот же путь, что 403', async () => {
    const fixture = await userWithChart();
    telegram.pushOutcome = 'not_found';

    const result = await run(atMoscow(8));

    expect(result.blocked).toBe(1);
    const log = await ctx.db.queryOne<{ error: string | null }>(
      `SELECT error FROM push_log WHERE user_id = $1`,
      [fixture.userId],
    );
    expect(log?.error).toBe('chat_not_found');
  });

  it('429: ждём retry_after и продолжаем с того же человека', async () => {
    await userWithChart();
    telegram.pushQueue.push('rate_limited', 'sent');
    telegram.pushRetryAfter = 7;

    const result = await run(atMoscow(8));

    expect(result.sent).toBe(1);
    expect(telegram.pushes).toHaveLength(2);
  });

  it('429 дольше трёх ожиданий → deferred, в журнале rate_limited', async () => {
    const fixture = await userWithChart();
    telegram.pushOutcome = 'rate_limited';

    const result = await run(atMoscow(8));

    expect(result.deferred).toBe(1);
    expect(result.sent).toBe(0);
    // Три ожидания `retry_after` — четыре попытки, после третьего ожидания
    // получатель уходит в `deferred` и не блокирует остальных.
    expect(telegram.pushes).toHaveLength(4);

    const log = await ctx.db.queryOne<{ error: string | null }>(
      `SELECT error FROM push_log WHERE user_id = $1`,
      [fixture.userId],
    );
    expect(log?.error).toBe('rate_limited');
  });

  it('500: ровно один повтор в том же окне, потом ошибка в журнале', async () => {
    const fixture = await userWithChart();
    telegram.pushOutcome = 'failed';

    const result = await run(atMoscow(8));

    expect(result.failed).toBe(1);
    expect(telegram.pushes).toHaveLength(2);

    const log = await ctx.db.queryOne<{ error: string | null }>(
      `SELECT error FROM push_log WHERE user_id = $1`,
      [fixture.userId],
    );
    expect(log?.error).toBe('telegram_failed');
  });

  it('500, когда окно уже закрылось → второго раза нет', async () => {
    await userWithChart();
    telegram.pushOutcome = 'failed';

    // Клок внутри прогона «переехал» на 08:10 — повтор уже не «утренний».
    const at = atMoscow(8, 3);
    const result = await engagement.runPush(at, {
      sleep: () => Promise.resolve(),
      sendGapMs: 0,
      retryDelayMs: 0,
      now: () => atMoscow(8, 10),
    });

    expect(result.failed).toBe(1);
    expect(telegram.pushes).toHaveLength(1);
  });
});

describe('утренний пуш: выключенный флаг', () => {
  it('PUSH_ENABLED=0 — пуш молчит и не пишет циклов', async () => {
    const offCtx = await createTestContext({
      astro: makeFakeAstro(),
      telegram,
      env: { PUSH_ENABLED: '0' },
    });

    try {
      const service = offCtx.app.get(EngagementService);
      const result = await service.runPush(atMoscow(8), optionsFor(atMoscow(8)));

      expect(result.enabled).toBe(false);
      expect(result.sent).toBe(0);
      expect(telegram.pushes).toHaveLength(0);

      const runs = await offCtx.db.query<{ total: string }>(`SELECT count(*)::text AS total FROM push_runs`);
      expect(runs[0]?.total).toBe('0');

      // `/health` показывает выключенную функцию именно выключенной: иначе
      // мониторинг ждал бы пушей от того, чего не существует. Состояние
      // вебхука подменяем на `ok` — в тестах он не проверялся и всегда
      // `stale`, а проверяем мы вклад пуша.
      offCtx.app.get(TelegramWebhookService).health = () => ({
        state: 'ok',
        ok: true,
        checkedAt: new Date().toISOString(),
      });
      const health = await request(offCtx.app.getHttpServer()).get('/api/v1/health').expect(200);
      expect(health.body.flags.push).toEqual({
        enabled: false,
        last_run_at: null,
        last_sent_count: 0,
      });
      expect(health.body.status).toBe('ok');
    } finally {
      await offCtx.close();
    }
  });
});

describe('утренний пуш: наблюдаемость', () => {
  /**
   * В тестах вебхук Telegram не проверялся, поэтому `/health` всегда
   * `degraded`. Чтобы проверить именно вклад пуша, состояние вебхука
   * подменяем на `ok` — остальные зависимости в тестах здоровы.
   */
  function webhookOk(): void {
    const webhook = ctx.app.get(TelegramWebhookService);
    webhook.health = () => ({ state: 'ok', ok: true, checkedAt: new Date().toISOString() });
  }

  it('/health: включённый пуш без прогонов делает status degraded', async () => {
    await userWithChart();
    webhookOk();

    const before = await request(ctx.app.getHttpServer()).get('/api/v1/health').expect(200);
    expect(before.body.flags.push).toEqual({
      enabled: true,
      last_run_at: null,
      last_sent_count: 0,
    });
    // Планировщик ни разу не отработал — это поломка, а не «ещё не утро».
    expect(before.body.status).toBe('degraded');

    await run(atMoscow(8));

    const after = await request(ctx.app.getHttpServer()).get('/api/v1/health').expect(200);
    expect(after.body.flags.push.last_sent_count).toBe(1);
    expect(after.body.flags.push.last_run_at).not.toBeNull();
    expect(after.body.status).toBe('ok');
  });

  it('/health: прогон старше двух часов снова деградирует', async () => {
    await userWithChart();
    webhookOk();
    await run(atMoscow(8));

    await ctx.db.query(`UPDATE push_runs SET finished_at = now() - interval '3 hours'`);

    const health = await request(ctx.app.getHttpServer()).get('/api/v1/health').expect(200);
    expect(health.body.flags.push.enabled).toBe(true);
    expect(health.body.status).toBe('degraded');
  });

  it('/admin/metrics: отправлено, провалено и дубли за сутки', async () => {
    await userWithChart();
    const at = atMoscow(8);

    await run(at);
    await run(at);
    telegram.pushOutcome = 'failed';
    await ctx.db.query(`DELETE FROM push_log`);
    await run(at);

    const metrics = await request(ctx.app.getHttpServer())
      .get('/api/v1/admin/metrics')
      .set(INIT_DATA_HEADER, initDataFor(FICTIONAL_USER.id))
      .expect(200);

    expect(metrics.body.push_sent_24h).toBe(0);
    expect(metrics.body.push_failed_24h).toBe(1);
    expect(metrics.body.push_duplicate_prevented_24h).toBe(0);
    expect(metrics.body.push_skipped_no_tz_24h).toBe(0);

    // Защита от дублей живёт в `push_runs`: проигравший гонку ничего не пишет
    // в `push_log`, поэтому в журнале её не видно.
    await ctx.db.query(
      `INSERT INTO push_runs (candidates, sent, duplicate_prevented, ms)
       VALUES (2, 1, 1, 120)`,
    );

    const afterRace = await request(ctx.app.getHttpServer())
      .get('/api/v1/admin/metrics')
      .set(INIT_DATA_HEADER, initDataFor(FICTIONAL_USER.id))
      .expect(200);
    expect(afterRace.body.push_duplicate_prevented_24h).toBe(1);
  });

  it('/admin/alerts: больше 20 провалов пуша — warning push_failed', async () => {
    const fixture = await userWithChart();
    // 21 провал за сутки: порог 20 превышен на единицу.
    await ctx.db.query(
      `INSERT INTO push_log (user_id, local_date, kind, error)
       SELECT $1, current_date - (n || ' days')::interval, 'daily_forecast', 'telegram_failed'
         FROM generate_series(1, 21) AS n`,
      [fixture.userId],
    );

    const alerts = await request(ctx.app.getHttpServer())
      .get('/api/v1/admin/alerts')
      .set(INIT_DATA_HEADER, initDataFor(FICTIONAL_USER.id))
      .expect(200);

    const rule = (alerts.body.alerts as { id: string; level: string; value: number; fired: boolean }[]).find(
      (entry) => entry.id === 'push_failed',
    );

    expect(rule).toMatchObject({ level: 'warning', value: 21, fired: true });
  });

  it('один провал алерт не поднимает: 20 — ещё не «сломано»', async () => {
    const fixture = await userWithChart();
    await ctx.db.query(
      `INSERT INTO push_log (user_id, local_date, kind, error)
       VALUES ($1, current_date, 'daily_forecast', 'telegram_failed')`,
      [fixture.userId],
    );

    const alerts = await request(ctx.app.getHttpServer())
      .get('/api/v1/admin/alerts')
      .set(INIT_DATA_HEADER, initDataFor(FICTIONAL_USER.id))
      .expect(200);

    const rule = (alerts.body.alerts as { id: string; fired: boolean }[]).find(
      (entry) => entry.id === 'push_failed',
    );
    expect(rule?.fired).toBe(false);
  });
});

describe('кнопка «Отключить» (callback_query push_off)', () => {
  function callbackUpdate(id: string, data: string, telegramId: number): Record<string, unknown> {
    return {
      update_id: 1,
      callback_query: {
        id,
        data,
        from: { id: telegramId, is_bot: false, first_name: 'Тест' },
        message: { message_id: 5, chat: { id: telegramId, type: 'private' } },
      },
    };
  }

  async function pressOff(fixture: Fixture, callbackId = 'cb-1'): Promise<void> {
    await request(ctx.app.getHttpServer())
      .post(`/api/v1/internal/telegram/webhook/${TEST_WEBHOOK_SECRET}`)
      .set('x-telegram-bot-api-secret-token', TEST_WEBHOOK_SECRET)
      .send(callbackUpdate(callbackId, PUSH_OFF_CALLBACK, fixture.telegramId))
      .expect(200);
  }

  it('выключает daily_forecast, отвечает подсказкой и не шлёт сообщение', async () => {
    const fixture = await userWithChart();

    await pressOff(fixture);

    const user = await ctx.db.queryOne<{ push_enabled: boolean }>(
      `SELECT push_enabled FROM users WHERE id = $1`,
      [fixture.userId],
    );
    expect(user?.push_enabled).toBe(false);

    expect(telegram.callbackAnswers).toHaveLength(1);
    expect(telegram.callbackAnswers[0]?.text).toBe(
      'Больше не буду присылать. Включить можно в кабинете',
    );
    // Ни нового сообщения, ни пуша: отказ не должен выглядеть как рассылка.
    expect(telegram.messages).toHaveLength(0);
    expect(telegram.pushes).toHaveLength(0);

    // Согласие видно в кабинете: тот же флаг отдаёт `GET /me`.
    const me = await request(ctx.app.getHttpServer())
      .get('/api/v1/me')
      .set(INIT_DATA_HEADER, initDataFor(fixture.telegramId))
      .expect(200);
    expect(me.body.notifications.daily_forecast).toBe(false);
  });

  it('идемпотентен: второе нажатие ничего не меняет и не пишет второе событие', async () => {
    const fixture = await userWithChart();

    await pressOff(fixture, 'cb-1');
    await pressOff(fixture, 'cb-2');

    const events = await ctx.db.query<{ total: string }>(
      `SELECT count(*)::text AS total FROM events WHERE name = 'push_disabled'`,
    );
    expect(events[0]?.total).toBe('1');
    expect(telegram.callbackAnswers).toHaveLength(2);
    expect(telegram.messages).toHaveLength(0);
  });

  it('после отказа следующий цикл не шлёт пуш', async () => {
    const fixture = await userWithChart();

    await pressOff(fixture);

    expect((await run(atMoscow(8))).sent).toBe(0);
    expect(telegram.pushes).toHaveLength(0);
  });
});

describe('присутствие (last_seen_at)', () => {
  it('любой авторизованный запрос отмечает визит', async () => {
    const fixture = await userWithChart();

    await ctx.db.query(`UPDATE users SET last_seen_at = NULL WHERE id = $1`, [fixture.userId]);
    // Создание карты уже отметило визит; «минута» в памяти иначе съела бы
    // следующий запрос, и тест проверял бы не то.
    ctx.app.get(PresenceService).reset();

    await request(ctx.app.getHttpServer())
      .get('/api/v1/me')
      .set(INIT_DATA_HEADER, initDataFor(fixture.telegramId))
      .expect(200);

    // UPDATE идёт «в фоне»: даём ему доехать до базы.
    const seen = await waitFor(async () => {
      const row = await ctx.db.queryOne<{ last_seen_at: Date | null }>(
        `SELECT last_seen_at FROM users WHERE id = $1`,
        [fixture.userId],
      );
      return row?.last_seen_at ?? null;
    });

    expect(seen).not.toBeNull();
  });
});

async function waitFor<T>(probe: () => Promise<T | null>, attempts = 20): Promise<T | null> {
  for (let i = 0; i < attempts; i += 1) {
    const value = await probe();
    if (value !== null) {
      return value;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
  }
  return null;
}

describe('текст пуша: 96 комбинаций «8 фаз × 12 знаков»', () => {
  const SIGNS = [
    'Овен',
    'Телец',
    'Близнецы',
    'Рак',
    'Лев',
    'Дева',
    'Весы',
    'Скорпион',
    'Стрелец',
    'Козерог',
    'Водолей',
    'Рыбы',
  ] as const;

  const combos = MOON_PHASES.flatMap((phase) => SIGNS.map((sign) => ({ phase, sign })));

  it('ровно 96 комбинаций: восемь фаз в списке сайдкара', () => {
    expect(MOON_PHASES).toHaveLength(8);
    expect(combos).toHaveLength(96);
  });

  it.each(combos)('$sign / $phase: длина, эмодзи, запрещённые темы', ({ sign, phase }) => {
    const message = buildPushMessage({ sign, phase });

    // 200 символов — жёсткий лимит всего текста без кнопок.
    expect(message.visibleLength).toBeLessThanOrEqual(PUSH_MAX_CHARS);
    expect(message.text.startsWith(PHASE_EMOJI[phase])).toBe(true);

    // Вторая строка ≤ 120 символов (без HTML-экранирования считаем по видимому).
    const line = message.text.split('\n\n')[1] ?? '';
    expect(line.length).toBeLessThanOrEqual(120);
    expect(line.startsWith('Луна в ')).toBe(true);

    // Никакой мистики: разрешён только эмодзи фазы.
    for (const emoji of FORBIDDEN_EMOJI) {
      expect(message.text).not.toContain(emoji);
    }

    // Никаких чисел, процентов и рейтингов: пуш не обещает и не измеряет.
    // Единственная цифра во всём тексте — «5» в константe «Разбор дня на
    // 5 минут»: это обещанная формулировка, а не обещание результата.
    const facts = [message.text.split('\n\n')[0] ?? '', line].join('\n');
    expect(facts).not.toMatch(/\d/u);
    expect(message.text.match(/\d/gu)).toHaveLength(1);
    expect(message.text).not.toContain('%');

    // Запрещённые темы — те же, что у разборов (медицина, право, деньги,
    // смерть, третьи лица, взрослое).
    expect(forbiddenTopicIn(line)).toBeNull();
    expect(forbiddenTopicIn(message.text)).toBeNull();

    // Ни обращения по имени, ни рода: текст один для всех.
    expect(message.text).not.toMatch(/ты |твой|твоя|дорог/iu);
  });

  it('вторая строка берёт фразу из MOON_ADVICE, а не выдумывает', () => {
    for (const phase of MOON_PHASES) {
      const line = buildPushMessage({ sign: 'Рыбы', phase }).text.split('\n\n')[1] ?? '';
      expect(line).toContain(MOON_ADVICE[phase]);
    }
  });

  it('HTML экранируется: знак с & и <> не ломает parse_mode', () => {
    const message = buildPushMessage({ sign: 'Личный рельеф & <тест>', phase: 'полнолуние' });

    expect(message.text).toContain('&amp;');
    expect(message.text).toContain('&lt;');
    expect(message.text).toContain('&gt;');
    expect(message.text).not.toContain('<тест>');
    expect(message.text).not.toContain('& <');
  });

  it('нет ссылок на Телеграм и ПДн', () => {
    for (const phase of MOON_PHASES) {
      const message = buildPushMessage({ sign: 'Рыбы', phase });
      expect(message.text).not.toContain('t.me/');
      expect(message.text).not.toContain('tg://');
      // Даты, координаты и города рождения в тексте не появляются вовсе.
      expect(message.text).not.toMatch(/\d{4}-\d{2}-\d{2}/u);
    }
  });
});
