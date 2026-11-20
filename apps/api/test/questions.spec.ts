import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { INIT_DATA_HEADER } from '../src/modules/auth/init-data';
import { JsonLogger } from '../src/common/logger';
import type { LlmProvider, LlmRequest, LlmResponse } from '../src/modules/llm/llm.client';
import { createTestContext, truncateAll, type TestContext } from './test-app';
import { signInitData } from './init-data-fixture';
import { FICTIONAL_USER, TEST_BOT_TOKEN } from './test-env';
import { makeFakeAstro } from './fake-astro';
import { makeFakeTelegram } from './fake-telegram';

/**
 * «Спроси карту» (контракт 1.6.6, итерация 30).
 *
 * Проверяются обещания, которые нельзя подтвердить глазами в браузере:
 *
 *   1. **Отказ по теме не доходит до модели** — иначе медицинский вопрос стоил
 *      бы денег, а ответ на него пришёл бы от языковой модели. Классов шесть,
 *      и для каждого проверяется и причина, и отсутствие вызова.
 *   2. **Квота не тратится на отказ** и **не теряется** на гонке: двойной тап
 *      не съедает две попытки из трёх.
 *   3. **Текст вопроса не попадает в логи** — только хеш, длина и тема.
 *   4. **Повтор с тем же `Idempotency-Key` не стоит второго вызова.**
 *   5. **Провал не тратит попытку и не виден в истории** (1.6.7): сбой
 *      возвращает квоту, а в `GET /questions` остаются `ready`, `refused` и
 *      `pending`. Значения `/admin/metrics` держат провалы наблюдаемыми.
 */

const BIRTH = {
  birth_date: '1994-05-17',
  birth_time: '14:20',
  time_precision: 'exact',
  birth_place: { name: 'Москва', country: 'RU', lat: 55.7558, lon: 37.6173, tz: 'Europe/Moscow' },
  consent: { accepted: true, version: '2026-11-10' },
};

const ADMIN_TG_ID = String(FICTIONAL_USER.id);

function initDataFor(): string {
  return signInitData({ botToken: TEST_BOT_TOKEN, user: FICTIONAL_USER });
}

function pad(min: number, seed: string): string {
  let text = '';
  while (text.length < min) {
    text += `${seed} Ты опираешься на Солнце и держишь ровный темп. `;
  }
  return text.trim();
}

/** То же наполнение, но без единого слова из карты (проверка `ungrounded`). */
function ungroundedPad(min: number, seed: string): string {
  let text = '';
  while (text.length < min) {
    text += `${seed} Держи ровный темп и не спеши с выводами. `;
  }
  return text.trim();
}

function answerJson(): string {
  return JSON.stringify({
    answer: pad(170, 'Вопрос про выбор, а не про сроки.'),
    why: pad(270, 'Луна в карте отвечает за настроение, Солнце — за волю.'),
    do: pad(170, 'Один шаг: выпиши два варианта и выбери меньший.'),
  });
}

interface ScriptedLlm extends LlmProvider {
  readonly calls: LlmRequest[];
  content: string;
  fail: boolean;
  hang: boolean;
  costRub: number;
}

function makeLlm(): ScriptedLlm {
  const llm: ScriptedLlm = {
    name: 'scripted-questions',
    calls: [],
    content: answerJson(),
    fail: false,
    hang: false,
    costRub: 0.4,
    complete(input: LlmRequest): Promise<LlmResponse> {
      llm.calls.push(input);
      if (llm.hang) {
        return new Promise<LlmResponse>(() => {
          /* никогда: проверяется состояние `pending` */
        });
      }
      if (llm.fail) {
        return Promise.reject(new Error('scripted provider: отказ по требованию теста'));
      }
      return Promise.resolve({
        content: llm.content,
        model: llm.name,
        usage: { promptTokens: 700, completionTokens: 260, totalTokens: 960, costRub: llm.costRub },
      });
    },
  };
  return llm;
}

interface Quota {
  readonly used: number;
  readonly limit: number;
  readonly resets_at: string;
}

interface QuestionView {
  readonly id: string;
  readonly status: 'pending' | 'ready' | 'failed' | 'refused';
  readonly question: string;
  readonly sections: readonly { key: string; title: string; body: string }[];
  readonly chars: number;
  readonly warnings: readonly string[];
  readonly reason: string | null;
  readonly topic: string;
  readonly message: string | null;
  readonly disclaimer: string;
  readonly quota: Quota;
}

interface MetricsView {
  readonly forecast_ready_24h: number;
  readonly forecast_failed_24h: number;
  readonly forecast_facts_only_24h: number;
  readonly forecast_cache_hits_24h: number;
  readonly forecast_cost_rub_24h: number;
  readonly questions_ready_24h: number;
  readonly questions_failed_24h: number;
  readonly questions_refused_24h: number;
  readonly questions_refused_by_reason: Record<string, number>;
  readonly questions_cost_rub_24h: number;
  readonly question_p95_ms: number;
  readonly compat_failed_24h: number;
}

interface Accepted {
  readonly id: string;
  readonly status: string;
  readonly quota: Quota;
}

let ctx: TestContext;
let llm: ScriptedLlm;

beforeAll(async () => {
  llm = makeLlm();
  ctx = await createTestContext({
    astro: makeFakeAstro(),
    telegram: makeFakeTelegram(),
    llm,
    env: { ADMIN_TG_ID },
  });
});

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  await truncateAll(ctx.db);
  llm.calls.length = 0;
  llm.content = answerJson();
  llm.fail = false;
  llm.hang = false;
  llm.costRub = 0.4;
  vi.restoreAllMocks();
});

async function userWithChart(): Promise<string> {
  await request(ctx.app.getHttpServer())
    .post('/api/v1/charts')
    .set(INIT_DATA_HEADER, initDataFor())
    .send(BIRTH)
    .expect(201);

  const user = await ctx.db.queryOne<{ id: string }>(`SELECT id FROM users`);
  return user?.id ?? '';
}

async function makePaid(userId: string): Promise<void> {
  await ctx.db.query(
    `INSERT INTO subscriptions (user_id, plan, status, expires_at)
     VALUES ($1, 'month', 'active', now() + interval '30 days')`,
    [userId],
  );
}

function ask(question: string, idemKey = `key-${Math.random().toString(36).slice(2)}`) {
  return request(ctx.app.getHttpServer())
    .post('/api/v1/questions')
    .set(INIT_DATA_HEADER, initDataFor())
    .set('Idempotency-Key', idemKey)
    .send({ question });
}

function questionById(id: string) {
  return request(ctx.app.getHttpServer())
    .get(`/api/v1/questions/${id}`)
    .set(INIT_DATA_HEADER, initDataFor());
}

/** Ответ готовится в фоне: ждём, пока строка перестанет быть `pending`. */
async function waitReady(id: string): Promise<QuestionView> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const response = await questionById(id).expect(200);
    const body = response.body as QuestionView;
    if (body.status !== 'pending') {
      return body;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  throw new Error(`вопрос ${id} так и остался pending`);
}

describe('POST /questions — доступ и форма', () => {
  it('без подписки — 403 subscription_required и ни одного вызова модели', async () => {
    await userWithChart();

    const response = await ask('Стоит ли мне менять работу этой осенью?').expect(403);

    expect(response.body.details?.reason).toBe('subscription_required');
    expect(llm.calls).toHaveLength(0);
  });

  it('подписка: 202 pending, затем три раздела и квота', async () => {
    const userId = await userWithChart();
    await makePaid(userId);

    const accepted = await ask('Стоит ли мне менять работу этой осенью?').expect(202);
    const body = accepted.body as Accepted;

    expect(body.status).toBe('pending');
    expect(body.quota).toMatchObject({ used: 1, limit: 3 });
    expect(body.quota.resets_at).toMatch(/Z$/u);

    const ready = await waitReady(body.id);
    expect(ready.status).toBe('ready');
    expect(ready.sections.map((section) => section.key)).toEqual(['answer', 'why', 'do']);
    expect(ready.sections.map((section) => section.title)).toEqual(['Ответ', 'Почему', 'Что сделать']);
    expect(ready.chars).toBeGreaterThanOrEqual(550);
    expect(ready.chars).toBeLessThanOrEqual(950);
    expect(ready.warnings).toEqual([]);
    expect(ready.disclaimer.length).toBeGreaterThan(10);
    expect(ready.question).toBe('Стоит ли мне менять работу этой осенью?');

    expect(llm.calls).toHaveLength(1);
  });

  it('ответ без опоры на карту помечается ungrounded, но не выбрасывается', async () => {
    const userId = await userWithChart();
    await makePaid(userId);

    // Позиций карты здесь нет ни одной — ни планеты, ни знака.
    llm.content = JSON.stringify({
      answer: ungroundedPad(170, 'Всё зависит от того, что для тебя важно сейчас.'),
      why: ungroundedPad(270, 'Решения складываются из привычек и опыта.'),
      do: ungroundedPad(170, 'Один шаг: назови вслух то, чего хочется больше.'),
    });

    const accepted = await ask('Как мне решиться на перемены в жизни?').expect(202);
    const ready = await waitReady((accepted.body as Accepted).id);

    expect(ready.status).toBe('ready');
    expect(ready.warnings).toContain('ungrounded');
  });

  it('невалидный вопрос — 422 с details.field_errors', async () => {
    const userId = await userWithChart();
    await makePaid(userId);

    for (const bad of ['', 'коротко', 'а'.repeat(301), 'Посмотри https://example.com и скажи']) {
      const response = await ask(bad).expect(422);
      expect(response.body.details?.field_errors?.[0]?.field).toBe('question');
    }

    const noKey = await request(ctx.app.getHttpServer())
      .post('/api/v1/questions')
      .set(INIT_DATA_HEADER, initDataFor())
      .send({ question: 'Стоит ли мне менять работу этой осенью?' })
      .expect(422);
    expect(noKey.body.details?.field_errors?.[0]?.field).toBe('Idempotency-Key');

    expect(llm.calls).toHaveLength(0);
  });
});

describe('POST /questions — отказы по теме', () => {
  const CASES: readonly { question: string; reason: string }[] = [
    { question: 'У меня болит спина, что делать с этим?', reason: 'medical' },
    { question: 'Стоит ли подавать иск в суд на соседа?', reason: 'legal' },
    { question: 'Взять ли кредит на машину в этом году?', reason: 'money' },
    { question: 'Не умрёт ли моя мама в этом году?', reason: 'death' },
    { question: 'Меня любит мой муж или уже нет?', reason: 'third_party' },
    { question: 'Стоит ли пробовать интим втроём с партнёром?', reason: 'adult' },
  ];

  it.each(CASES)('$question — refused/$reason без вызова модели', async ({ question, reason }) => {
    const userId = await userWithChart();
    await makePaid(userId);

    const response = await ask(question).expect(202);
    const body = response.body as Accepted;

    expect(body.status).toBe('refused');
    // Квота не тронута: отказ — не ответ, платить за него нечем.
    expect(body.quota.used).toBe(0);

    const view = await waitReady(body.id);
    expect(view.status).toBe('refused');
    expect(view.reason).toBe(reason);
    expect(view.sections).toEqual([]);
    expect(view.message?.length ?? 0).toBeGreaterThan(20);

    expect(llm.calls).toHaveLength(0);
    const usage = await ctx.db.queryOne<{ count: number }>(`SELECT count FROM question_usage`);
    expect(usage).toBeNull();
  });

  it('повтор отказа с тем же ключом возвращает тот же id', async () => {
    const userId = await userWithChart();
    await makePaid(userId);

    const first = await ask('Стоит ли подавать иск в суд на соседа?', 'refusal-key').expect(202);
    const second = await ask('Стоит ли подавать иск в суд на соседа?', 'refusal-key').expect(202);

    expect((second.body as Accepted).id).toBe((first.body as Accepted).id);
    expect(llm.calls).toHaveLength(0);
  });
});

describe('POST /questions — квоты, идемпотентность, гонки', () => {
  it('второй вопрос, пока первый в работе, — 409 и квота возвращается', async () => {
    const userId = await userWithChart();
    await makePaid(userId);

    llm.hang = true;
    const first = await ask('Стоит ли мне менять работу этой осенью?').expect(202);
    expect((first.body as Accepted).status).toBe('pending');

    const second = await ask('Что мне делать с усталостью по вечерам?').expect(409);
    expect(second.body.details?.reason).toBe('question_in_progress');

    const usage = await ctx.db.queryOne<{ count: number }>(`SELECT count FROM question_usage`);
    // Одна попытка, а не две: за отклонённый запрос модели не было.
    expect(usage?.count).toBe(1);
    expect(llm.calls).toHaveLength(1);
  });

  it('четвёртый вопрос за сутки — 403 quota_exhausted с resets_at', async () => {
    const userId = await userWithChart();
    await makePaid(userId);

    for (let index = 0; index < 3; index += 1) {
      const response = await ask(`Вопрос номер ${index} про работу и планы?`).expect(202);
      await waitReady((response.body as Accepted).id);
    }

    const response = await ask('Ещё один вопрос про работу и планы?').expect(403);
    expect(response.body.details?.reason).toBe('quota_exhausted');
    expect(response.body.details?.quota).toMatchObject({ used: 3, limit: 3 });
    expect(response.body.details?.resets_at).toMatch(/Z$/u);
  });

  it('провал генерации не тратит попытку: квота возвращается', async () => {
    const userId = await userWithChart();
    await makePaid(userId);

    // Три провала подряд — весь дневной лимит. Если бы сбой списывал попытку,
    // после них человек остался бы с нулём ответов и закрытой квотой.
    llm.fail = true;
    for (const index of [1, 2, 3]) {
      const accepted = await ask(`Вопрос номер ${index} про работу и планы?`).expect(202);
      // На приёме попытка списана — иначе гонка съедала бы две сразу.
      expect((accepted.body as Accepted).quota.used).toBe(1);

      const view = await waitReady((accepted.body as Accepted).id);
      expect(view.status).toBe('failed');
      // Провал вернул попытку: модель отработала в минус, а не за счёт человека.
      expect(view.quota.used).toBe(0);
    }

    const usage = await ctx.db.queryOne<{ count: number }>(`SELECT count FROM question_usage`);
    expect(usage?.count).toBe(0);

    // И четвёртая попытка не упирается в 403: лимит по-прежнему открыт.
    llm.fail = false;
    const accepted = await ask('Стоит ли мне менять работу этой осенью?').expect(202);
    const ready = await waitReady((accepted.body as Accepted).id);
    expect(ready.status, String(ready.reason)).toBe('ready');
    expect(ready.quota.used).toBe(1);
  });

  it('повтор с тем же Idempotency-Key — тот же id и один вызов модели', async () => {
    const userId = await userWithChart();
    await makePaid(userId);

    const first = await ask('Стоит ли мне менять работу этой осенью?', 'same-key').expect(202);
    const id = (first.body as Accepted).id;
    await waitReady(id);

    const second = await ask('Стоит ли мне менять работу этой осенью?', 'same-key').expect(202);
    expect((second.body as Accepted).id).toBe(id);

    // Квота не удвоилась: повтор — тот же вопрос.
    const usage = await ctx.db.queryOne<{ count: number }>(`SELECT count FROM question_usage`);
    expect(usage?.count).toBe(1);
    expect(llm.calls).toHaveLength(1);
  });

  it('дневной потолок расходов — 429 daily_cost_cap, а не молчание', async () => {
    // Окружение читается один раз при старте приложения, поэтому потолок
    // задаётся отдельным контекстом: один ответ стоит 0,4 ₽ при потолке
    // 0,3 ₽ — второй вопрос упирается в лимит.
    const cheap = await createTestContext({
      astro: makeFakeAstro(),
      telegram: makeFakeTelegram(),
      llm,
      env: { ADMIN_TG_ID, LLM_QUESTION_DAILY_CAP_RUB: '0.3' },
    });

    try {
      await truncateAll(cheap.db);
      const chart = await request(cheap.app.getHttpServer())
        .post('/api/v1/charts')
        .set(INIT_DATA_HEADER, initDataFor())
        .send(BIRTH)
        .expect(201);
      expect(chart.status).toBe(201);

      const user = await cheap.db.queryOne<{ id: string }>(`SELECT id FROM users`);
      await cheap.db.query(
        `INSERT INTO subscriptions (user_id, plan, status, expires_at)
         VALUES ($1, 'month', 'active', now() + interval '30 days')`,
        [user?.id],
      );

      const post = (question: string, key: string) =>
        request(cheap.app.getHttpServer())
          .post('/api/v1/questions')
          .set(INIT_DATA_HEADER, initDataFor())
          .set('Idempotency-Key', key)
          .send({ question });

      const response = await post('Стоит ли мне менять работу этой осенью?', 'cap-1').expect(202);

      // Ждём готовности через тот же (дешёвый) контекст.
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const view = await request(cheap.app.getHttpServer())
          .get(`/api/v1/questions/${(response.body as Accepted).id}`)
          .set(INIT_DATA_HEADER, initDataFor());
        if ((view.body as QuestionView).status !== 'pending') {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }

      const capped = await post('Что мне делать с усталостью по вечерам?', 'cap-2').expect(429);
      expect(capped.body.details?.reason).toBe('daily_cost_cap');
      expect(capped.body.details?.resets_at).toMatch(/Z$/u);
    } finally {
      await cheap.close();
    }
  });
});

describe('GET /questions — история и приватность', () => {
  it('история отдаёт готовые ответы и квоту', async () => {
    const userId = await userWithChart();
    await makePaid(userId);

    const accepted = await ask('Стоит ли мне менять работу этой осенью?').expect(202);
    await waitReady((accepted.body as Accepted).id);

    const response = await request(ctx.app.getHttpServer())
      .get('/api/v1/questions?limit=20')
      .set(INIT_DATA_HEADER, initDataFor())
      .expect(200);

    expect(response.body.items).toHaveLength(1);
    expect(response.body.items[0].status).toBe('ready');
    expect(response.body.quota).toMatchObject({ used: 1, limit: 3 });
  });

  it('текст вопроса не попадает в логи — только хеш, длина и тема', async () => {
    const userId = await userWithChart();
    await makePaid(userId);

    const captured: string[] = [];
    for (const method of ['info', 'warn', 'error', 'debug'] as const) {
      // `bind` — чтобы ESLint не считал метод «оторванным»: он действительно
      // вызывается на прототипе, и `this` там нужен настоящий.
      const original = JsonLogger.prototype[method].bind(JsonLogger.prototype);
      vi.spyOn(JsonLogger.prototype, method).mockImplementation(function (
        this: JsonLogger,
        message: string,
        fields?: Record<string, unknown>,
      ) {
        captured.push(`${message} ${JSON.stringify(fields ?? {})}`);
        return original(message, fields);
      });
    }

    const secret = 'Стоит ли мне увольняться из ненавистного офиса на Коломенской?';
    const accepted = await ask(secret).expect(202);
    await waitReady((accepted.body as Accepted).id);

    // `markReady` и строка лога — два разных шага: статус меняется раньше, чем
    // пишется `question_ready`. Ждём именно лог, иначе тест зависит от гонки.
    for (let attempt = 0; attempt < 40 && !captured.join('\n').includes('question_hash'); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    expect(captured.length).toBeGreaterThan(0);
    for (const line of captured) {
      expect(line).not.toContain('Коломенской');
      expect(line).not.toContain('ненавистного');
    }

    const logged = captured.join('\n');
    expect(logged).toContain('question_hash');
    expect(logged).toContain('question_len');
  });

  it('DELETE /me удаляет вопросы и квоту каскадом', async () => {
    const userId = await userWithChart();
    await makePaid(userId);

    const accepted = await ask('Стоит ли мне менять работу этой осенью?').expect(202);
    await waitReady((accepted.body as Accepted).id);

    await request(ctx.app.getHttpServer())
      .delete('/api/v1/me')
      .set(INIT_DATA_HEADER, initDataFor())
      .expect(204);

    const questions = await ctx.db.query(`SELECT 1 FROM questions`);
    const usage = await ctx.db.query(`SELECT 1 FROM question_usage`);
    const forecasts = await ctx.db.query(`SELECT 1 FROM daily_forecasts`);
    expect(questions).toHaveLength(0);
    expect(usage).toHaveLength(0);
    expect(forecasts).toHaveLength(0);
  });

  it('чужой вопрос — 404, а не чужой текст', async () => {
    const userId = await userWithChart();
    await makePaid(userId);

    await ask('Стоит ли мне менять работу этой осенью?').expect(202);

    // Чужой id: в базе такого вопроса нет.
    const response = await request(ctx.app.getHttpServer())
      .get('/api/v1/questions/2f1d3c44-9b52-4a1e-8f0c-5c7f4b6a9d11')
      .set(INIT_DATA_HEADER, initDataFor())
      .expect(404);

    expect(response.body.details?.reason).toBe('question_not_found');
  });
});

describe('GET /questions — какие статусы попадают в историю (1.6.7)', () => {
  it('ready, refused и pending в списке, failed — нет; по id failed доступен', async () => {
    const userId = await userWithChart();
    await makePaid(userId);

    // 1. Готовый ответ — то, за чем человек и приходил.
    const readyAccepted = await ask('Стоит ли мне менять работу этой осенью?').expect(202);
    const ready = await waitReady((readyAccepted.body as Accepted).id);
    expect(ready.status, String(ready.reason)).toBe('ready');

    // 2. Отказ по теме — настоящий ответ карты, а не сбой: прятать нельзя.
    const refusedAccepted = await ask('Стоит ли подавать иск в суд на соседа?').expect(202);
    const refused = await waitReady((refusedAccepted.body as Accepted).id);
    expect(refused.status).toBe('refused');
    expect(refused.reason).toBe('legal');

    // 3. Сбой генерации — внутренняя история. Лог пишем в массив: скрытый из
    // истории провал должен остаться наблюдаемым, с причиной и без текста.
    const logs: string[] = [];
    const originalWarn = JsonLogger.prototype.warn.bind(JsonLogger.prototype);
    vi.spyOn(JsonLogger.prototype, 'warn').mockImplementation(function (
      this: JsonLogger,
      message: string,
      fields?: Record<string, unknown>,
    ) {
      logs.push(`${message} ${JSON.stringify(fields ?? {})}`);
      return originalWarn(message, fields);
    });

    llm.fail = true;
    const failedAccepted = await ask('Стоит ли мне переезжать в Лиссабон?').expect(202);
    const failed = await waitReady((failedAccepted.body as Accepted).id);
    expect(failed.status).toBe('failed');
    llm.fail = false;

    // 4. Вопрос в работе: «зависший» вызов модели. Ставим последним — он
    // держит слот `pending`, и следующий вопрос получил бы 409.
    llm.hang = true;
    const pendingAccepted = await ask('Что мне даст отпуск в горах в декабре?').expect(202);
    expect((pendingAccepted.body as Accepted).status).toBe('pending');

    const list = await request(ctx.app.getHttpServer())
      .get('/api/v1/questions?limit=20')
      .set(INIT_DATA_HEADER, initDataFor())
      .expect(200);

    // Четыре записи в БД, три в списке. Длина списка и есть счётчик после
    // фильтра: отдельного `total` в схеме нет (схемы в 1.6.7 не меняются).
    expect(list.body.items).toHaveLength(3);
    expect(
      (list.body.items as QuestionView[]).map((item) => item.status).sort(),
    ).toEqual(['pending', 'ready', 'refused']);
    expect(
      (list.body.items as QuestionView[]).some((item) => item.id === failed.id),
    ).toBe(false);

    // Статус меняется до записи в лог — ждём именно строку лога.
    for (let attempt = 0; attempt < 40 && !logs.some((line) => line.includes('question_failed')); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const failedLine = logs.find((line) => line.includes('question_failed'));
    expect(failedLine).toBeDefined();
    expect(failedLine).toContain('llm_error');
    expect(failedLine).toContain('"reason"');
    expect(failedLine).not.toContain('Лиссабон');

    // Квота: ready и pending списаны, refused и failed — нет.
    expect(list.body.quota).toMatchObject({ used: 2, limit: 3 });

    // Прямая ссылка не фильтруется — иначе провал не разобрать ни воркеру,
    // ни QA: 200 и настоящий статус.
    const byId = await questionById(failed.id).expect(200);
    expect((byId.body as QuestionView).status).toBe('failed');
    expect((byId.body as QuestionView).reason).toBe('llm_error');
    llm.hang = false;
  });
});

describe('GET /admin/metrics — счётчики прогноза и вопросов', () => {
  it('отдаёт все новые числа, включая отказы по причинам и p95', async () => {
    const userId = await userWithChart();
    await makePaid(userId);

    // Прогноз дня в этом файле не проверяется: стаб модели отвечает текстом
    // ответа на вопрос, и генерация прогноза честно упала бы в 503. Поэтому
    // счётчики прогноза здесь нулевые — и это тоже утверждение.
    const accepted = await ask('Стоит ли мне менять работу этой осенью?').expect(202);
    await waitReady((accepted.body as Accepted).id);
    await ask('Стоит ли подавать иск в суд на соседа?').expect(202);

    const response = await request(ctx.app.getHttpServer())
      .get('/api/v1/admin/metrics')
      .set(INIT_DATA_HEADER, initDataFor())
      .expect(200);

    const body = response.body as MetricsView;
    expect(body.forecast_ready_24h).toBe(0);
    expect(body.forecast_failed_24h).toBe(0);
    expect(body.forecast_facts_only_24h).toBe(0);
    expect(body.forecast_cache_hits_24h).toBe(0);
    expect(Number(body.forecast_cost_rub_24h)).toBe(0);
    expect(body.questions_ready_24h).toBe(1);
    expect(body.questions_failed_24h).toBe(0);
    expect(body.questions_refused_24h).toBe(1);
    expect(body.questions_refused_by_reason).toEqual({ legal: 1 });
    expect(Number(body.questions_cost_rub_24h)).toBeCloseTo(0.4, 4);
    expect(Number(body.question_p95_ms)).toBeGreaterThan(0);
    // Провалов совместимости в этом файле нет — счётчик обязан быть нулём,
    // а не отсутствовать: без него провал не виден нигде, кроме лога.
    expect(body.compat_failed_24h).toBe(0);
  });
});
