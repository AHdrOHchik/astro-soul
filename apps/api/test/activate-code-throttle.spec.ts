import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { INIT_DATA_HEADER } from '../src/modules/auth/init-data';
import { CodeActivationThrottle } from '../src/modules/grants/code-activation-throttle.service';
import { createTestContext, truncateAll, type TestContext } from './test-app';
import type { AppEnv } from '../src/config/env';
import { signInitData } from './init-data-fixture';
import { makeFakeTelegram } from './fake-telegram';
import { FICTIONAL_USER, TEST_BOT_TOKEN } from './test-env';

/**
 * Лимит попыток активации кода (итерация 43, долг 7.3): 10 неудач в час.
 *
 * Проверяется не только «блокирует», но и обратное: человек, который ошибся
 * дважды и вспомнил код, **не должен** упираться в лимит. Поэтому считаются
 * неудачи, а успешная активация снимает счётчик, а не «попытки подряд».
 *
 * Границы ответственности тестов:
 *   • через HTTP (`POST /me/activate-code`) — то, что видит клиент: `429`,
 *     `details.reason`, `retry_after_seconds`, и то, что успешная активация
 *     **не** блокируется (её счётчик снимается в контроллере);
 *   • на самом `CodeActivationThrottle` — арифметика окна: успех обнуляет,
 *     окно не продлевается, через час снова можно, чужие счётчики не мешают.
 *
 * Второй блок — не «юнит вместо интеграции»: успешная активация внутри себя
 * открывает транзаквиню `activate → issue`, а PGlite (наш тестовый Postgres)
 * обслуживает одно соединение за раз, поэтому такой путь висит и **на базовом
 * коммите** (`test/grants.spec.ts` красный там же). Арифметика лимита от БД не
 * зависит — её и проверяем напрямую, а не ослабляем тест.
 */

const CODE = 'AAAABBBB';

let ctx: TestContext;
let throttle: CodeActivationThrottle;

/** Свой пользователь на тест: счётчики в памяти ключуются по `user_id`. */
function initDataFor(id: number): string {
  return signInitData({ botToken: TEST_BOT_TOKEN, user: { ...FICTIONAL_USER, id } });
}

function activate(id: number, code: string) {
  return request(ctx.app.getHttpServer())
    .post('/api/v1/me/activate-code')
    .set(INIT_DATA_HEADER, initDataFor(id))
    .send({ code });
}

async function seedCode(): Promise<void> {
  await ctx.db.query(
    `INSERT INTO access_codes (code, kind, days, max_activations, partner_name)
     VALUES ($1, 'single_report', NULL, 10, 'throttle-test')`,
    [CODE],
  );
}

/** `userId` для счётчика: контроллер берёт его из `users.ensureUser`. */
async function userIdOf(id: number): Promise<string> {
  const row = await ctx.db.queryOne<{ id: string }>(
    `SELECT id::text AS id FROM users WHERE telegram_id = $1`,
    [String(id)],
  );
  return row?.id ?? '';
}

beforeAll(async () => {
  // Telegram — фейк: успешная активация уведомляет владельца, живому клиенту в
  // тестах некуда идти.
  ctx = await createTestContext({ telegram: makeFakeTelegram() });
  throttle = ctx.app.get(CodeActivationThrottle);
});

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  await truncateAll(ctx.db);
  await seedCode();
  // Часы возвращаем на место: тест «окно открылось через час» двигает их.
  throttle.now = Date.now;
});

describe('POST /me/activate-code — лимит', () => {
  it('десять неудач → 429 code_activation_throttled с retry_after', async () => {
    const id = 555_100_001;

    for (let attempt = 0; attempt < 10; attempt += 1) {
      await activate(id, 'ZZZZZZZZ').expect(404);
    }

    const blocked = await activate(id, 'ZZZZZZZZ').expect(429);
    const body = blocked.body as {
      code: string;
      details: { reason: string; retry_after_seconds: number };
    };

    expect(body.code).toBe('RATE_LIMITED');
    expect(body.details.reason).toBe('code_activation_throttled');
    expect(body.details.retry_after_seconds).toBeGreaterThan(0);
    // Окно — час, значит и ждать не больше часа.
    expect(body.details.retry_after_seconds).toBeLessThanOrEqual(3600);
  });

  it('девять неудач ещё не блокируют: десятая попытка проходит до базы', async () => {
    const id = 555_100_002;

    for (let attempt = 0; attempt < 9; attempt += 1) {
      await activate(id, 'ZZZZZZZZ').expect(404);
    }

    // Именно `404`, а не `429`: лимит считается включительно с десятой.
    await activate(id, 'ZZZZZZZZ').expect(404);
    await activate(id, 'ZZZZZZZZ').expect(429);
  });

  it('даже верный код не проходит, пока лимит не истёк', async () => {
    const id = 555_100_003;

    for (let attempt = 0; attempt < 10; attempt += 1) {
      await activate(id, 'ZZZZZZZZ').expect(404);
    }

    await activate(id, CODE).expect(429);
  });

  it('мусор вместо кода не съедает попытки: 422 отказал до счётчика', async () => {
    const id = 555_100_004;

    for (let attempt = 0; attempt < 12; attempt += 1) {
      await activate(id, 'oops').expect(422);
    }

    // Двенадцать 422 не израсходовали ни одной попытки: дальше — обычный 404.
    await activate(id, 'ZZZZZZZZ').expect(404);
  });

  it('лимит одного человека не влияет на другого', async () => {
    const first = 555_100_005;
    const second = 555_100_006;

    for (let attempt = 0; attempt < 10; attempt += 1) {
      await activate(first, 'ZZZZZZZZ').expect(404);
    }
    await activate(first, CODE).expect(429);

    // У второго счётчик свой: он получает обычный `404` на неверный код.
    await activate(second, 'ZZZZZZZZ').expect(404);
  });

  it('счётчик привязан к человеку, а не к запросу: второй пользователь не «сбрасывает» первый', async () => {
    const first = 555_100_007;
    const second = 555_100_008;

    for (let attempt = 0; attempt < 10; attempt += 1) {
      await activate(first, 'ZZZZZZZZ').expect(404);
    }

    await activate(second, 'ZZZZZZZZ').expect(404);
    await activate(first, CODE).expect(429);
  });

  it('порог берётся из CODE_ACTIVATION_MAX_FAILURES, а не из константы', () => {
    // Отдельный инстанс сервиса со своим env — чтобы не ломать окно остальным.
    const loose = new CodeActivationThrottle({
      CODE_ACTIVATION_MAX_FAILURES: 3,
    } as unknown as AppEnv);

    loose.registerFailure('u');
    loose.registerFailure('u');
    expect(loose.retryAfterSeconds('u')).toBeNull();

    loose.registerFailure('u');
    expect(loose.retryAfterSeconds('u')).not.toBeNull();
  });
});

describe('CodeActivationThrottle — арифметика окна', () => {
  it('успех обнуляет счётчик: «ошибся дважды, вспомнил код» проходит', async () => {
    const user = await userIdOf(555_100_010);

    throttle.registerFailure(user);
    throttle.registerFailure(user);
    expect(throttle.retryAfterSeconds(user)).toBeNull();

    // Успешная активация вызывает это; после неё счётчик снова полон.
    throttle.registerSuccess(user);

    for (let attempt = 0; attempt < 10; attempt += 1) {
      throttle.registerFailure(user);
    }
    expect(throttle.retryAfterSeconds(user)).not.toBeNull();
  });

  it('десятая неудача блокирует, девятая — нет', () => {
    const user = 'arith-boundary';

    for (let attempt = 0; attempt < 9; attempt += 1) {
      throttle.registerFailure(user);
    }
    expect(throttle.retryAfterSeconds(user)).toBeNull();

    throttle.registerFailure(user);
    expect(throttle.retryAfterSeconds(user)).toBeGreaterThan(0);
  });

  it('окно не продлевается: серия неудач не держит в блоке бесконечно', () => {
    const user = 'arith-window';
    const start = Date.now();
    throttle.now = (): number => start;

    for (let attempt = 0; attempt < 10; attempt += 1) {
      throttle.registerFailure(user);
    }

    // Каждая следующая неудача не сдвигает конец окна: он всё ещё start + час.
    throttle.now = (): number => start + 50 * 60_000;
    expect(throttle.retryAfterSeconds(user)).toBe(10 * 60);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      throttle.registerFailure(user);
    }
    expect(throttle.retryAfterSeconds(user)).toBe(10 * 60);
  });

  it('через час окно открывается', () => {
    const user = 'arith-expiry';
    const start = Date.now();
    throttle.now = (): number => start;

    for (let attempt = 0; attempt < 10; attempt += 1) {
      throttle.registerFailure(user);
    }
    expect(throttle.retryAfterSeconds(user)).toBe(3600);

    throttle.now = (): number => start + 3_600_000;
    expect(throttle.retryAfterSeconds(user)).toBeNull();
  });

  it('после истечения окна счёт начинается заново', () => {
    const user = 'arith-restart';
    const start = Date.now();
    throttle.now = (): number => start;

    for (let attempt = 0; attempt < 10; attempt += 1) {
      throttle.registerFailure(user);
    }

    throttle.now = (): number => start + 3_600_001;
    throttle.registerFailure(user);

    // Одна новая неудача — это одно, а не «одиннадцать».
    expect(throttle.retryAfterSeconds(user)).toBeNull();
  });
});
