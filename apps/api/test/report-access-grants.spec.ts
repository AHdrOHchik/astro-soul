import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { INIT_DATA_HEADER } from '../src/modules/auth/init-data';
import { AccessService, type AccessFeature } from '../src/modules/entitlements/access.service';
import { EntitlementsService } from '../src/modules/entitlements/entitlements.service';
import { AccessCodesService } from '../src/modules/grants/access-codes.service';
import { makeFakeAstro } from './fake-astro';
import { createTestContext, truncateAll, type TestContext } from './test-app';
import { signInitData } from './init-data-fixture';
import { FICTIONAL_USER, TEST_BOT_TOKEN } from './test-env';
import { makeFakeTelegram } from './fake-telegram';
import type { LlmProvider, LlmRequest, LlmResponse } from '../src/modules/llm/llm.client';

/**
 * Разбор и бесплатное право (итерация 44, контракт не менялся).
 *
 * Диагноз владельца: `all_access` открывал совместимость, а разбор оставался
 * платным — и через `all_access`, и через `single_report`. Причина была не в
 * коде активации (он писал ровно то, что обещал), а в двери:
 *   • `getEntitlements` в ветке «всё включено» поднимал четыре фичи из пяти —
 *     разбор забыли, поэтому `fullReport` оставался `false`;
 *   • `reportAccess` для разбора конкретной карты смотрел только оплаченный
 *     разбор и `single_report`, а грант `all_access` не спрашивал вовсе.
 *
 * Тесты ниже — матрица из пяти состояний аккаунта, а не описание симптома:
 * каждое состояние проверяется по **всем** пяти фичам двери.
 */
const BIRTH = {
  birth_date: '1994-05-17',
  birth_time: '14:20',
  time_precision: 'exact',
  birth_place: { name: 'Москва', country: 'RU', lat: 55.7558, lon: 37.6173, tz: 'Europe/Moscow' },
  consent: { accepted: true, version: '2026-11-10' },
};

const USER_ID = 444_200_001;
const USER_ID_2 = 444_200_002;

const FEATURES: readonly AccessFeature[] = [
  'full_forecast',
  'report',
  'compat',
  'ask',
  'solar',
];

type AccountState =
  | 'чистый аккаунт'
  | 'all_access активен'
  | 'all_access истёк'
  | 'single_report не израсходован'
  | 'single_compat не израсходован'
  | 'разбор оплачен и готов';

/** Ожидаемая матрица. Порядок фич — как в `FEATURES` выше. */
const MATRIX: Readonly<Record<AccountState, readonly [boolean, boolean, boolean, boolean, boolean]>> = {
  // прогноз, разбор, совместимость, вопросы, карта года
  'чистый аккаунт': [false, false, false, false, false],
  'all_access активен': [true, true, true, true, true],
  'all_access истёк': [false, false, false, false, false],
  'single_report не израсходован': [false, true, false, false, false],
  'single_compat не израсходован': [false, false, true, false, false],
  'разбор оплачен и готов': [false, true, false, false, false],
};

class ReadyProvider implements LlmProvider {
  readonly name = 'ready-stub';

  complete(input: LlmRequest): Promise<LlmResponse> {
    const prompt = input.messages.map((message) => message.content).join('\n');

    if (prompt.includes('Ответ — строго JSON')) {
      return Promise.resolve(
        this.answer(
          JSON.stringify({
            thesis: 'Ты держишь фокус на главном и не любишь суету.',
            focuses: [
              { topic: 'спокойная сила', factor: 'Солнце в Тельце', angle: 'устойчивость' },
              { topic: 'реакция на спешку', factor: 'Марс в Козероге', angle: 'терпение' },
            ],
            avoid: ['не повторять про силу'],
          }),
        ),
      );
    }

    const sentence = 'Ты выбираешь устойчивый темп и редко меняешь его под внешним давлением.';
    return Promise.resolve(this.answer([sentence, sentence, sentence, sentence, sentence, sentence, sentence].join(' ')));
  }

  private answer(content: string): LlmResponse {
    return {
      content,
      model: this.name,
      usage: { promptTokens: 800, completionTokens: 200, totalTokens: 1_000, costRub: 0.3 },
    };
  }
}

class FailingProvider implements LlmProvider {
  readonly name = 'failing-stub';

  complete(_input: LlmRequest): Promise<LlmResponse> {
    void _input;
    return Promise.reject(new Error('provider: соединение закрыто'));
  }
}

let ctx: TestContext;
const provider: LlmProvider = new ReadyProvider();
let access: AccessService;
let entitlements: EntitlementsService;
let codes: AccessCodesService;

function initDataFor(id: number = USER_ID): string {
  return signInitData({ botToken: TEST_BOT_TOKEN, user: { ...FICTIONAL_USER, id } });
}

async function newAccount(id: number = USER_ID): Promise<{ userId: string; chartId: string }> {
  const response = await request(ctx.app.getHttpServer())
    .post('/api/v1/charts')
    .set(INIT_DATA_HEADER, initDataFor(id))
    .send(BIRTH)
    .expect(201);

  const user = await ctx.db.queryOne<{ id: string }>(
    `SELECT id::text AS id FROM users WHERE telegram_id = $1`,
    [String(id)],
  );

  return { userId: user?.id ?? '', chartId: response.body.chart.chart_id as string };
}

/** Состояние аккаунта — прямо в таблицах, без кодов и платежей: матрица про дверь. */
async function seedState(state: AccountState, userId: string, chartId: string): Promise<void> {
  switch (state) {
    case 'чистый аккаунт':
      return;
    case 'all_access активен':
      await ctx.db.query(
        `INSERT INTO grants (user_id, kind, source, days, starts_at, expires_at)
         VALUES ($1, 'all_access', 'partner', 14, now(), now() + interval '14 days')`,
        [userId],
      );
      return;
    case 'all_access истёк':
      await ctx.db.query(
        `INSERT INTO grants (user_id, kind, source, days, starts_at, expires_at)
         VALUES ($1, 'all_access', 'partner', 14, now() - interval '15 days', now() - interval '1 day')`,
        [userId],
      );
      return;
    case 'single_report не израсходован':
      await ctx.db.query(
        `INSERT INTO grants (user_id, kind, source) VALUES ($1, 'single_report', 'admin')`,
        [userId],
      );
      return;
    case 'single_compat не израсходован':
      await ctx.db.query(
        `INSERT INTO grants (user_id, kind, source) VALUES ($1, 'single_compat', 'admin')`,
        [userId],
      );
      return;
    case 'разбор оплачен и готов':
      // Реальное состояние покупки: право на карту (`entitlements`) и готовый
      // текст. Без строки `entitlements` это был бы «купленный разбор, у
      // которого нет права», то есть другой дефект.
      await ctx.db.query(
        `INSERT INTO entitlements (user_id, kind, chart_id, status) VALUES ($1, 'report', $2, 'active')`,
        [userId, chartId],
      );
      await ctx.db.query(
        `INSERT INTO reports (user_id, chart_id, kind, status, idempotency_key, chart_hash,
                              model, prompt_version, report_structure_version, chart_facts_version)
         VALUES ($1, $2, 'report', 'ready', 'seed-ready', 'hash', 'stub', 'p1', 's1', 'c1')`,
        [userId, chartId],
      );
      return;
  }
}

beforeAll(async () => {
  ctx = await createTestContext({
    astro: makeFakeAstro(),
    telegram: makeFakeTelegram(),
    llm: provider,
    env: { REPORT_BREAKER_ENABLED: '0' },
  });

  access = ctx.app.get(AccessService);
  entitlements = ctx.app.get(EntitlementsService);
  codes = ctx.app.get(AccessCodesService);
});

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  await truncateAll(ctx.db);
});

describe('матрица доступа: состояние аккаунта × пять фич', () => {
  for (const state of Object.keys(MATRIX) as AccountState[]) {
    for (const [index, feature] of FEATURES.entries()) {
      it(`${state}: ${feature} = ${String(MATRIX[state][index])}`, async () => {
        const { userId, chartId } = await newAccount();
        await seedState(state, userId, chartId);

        const allowed = await access.hasAccess(userId, feature, { chartId });

        expect(allowed).toBe(MATRIX[state][index]);
      });
    }
  }

  it('`ask` открыт только тем, у кого действует подписка или право целиком', async () => {
    // Отдельной строкой: `askPerDay` у бесплатного уровня = 1 («вопрос в
    // подарок»), и однажды это уже открыло вопросы всем подряд. Дверь обязана
    // смотреть на `isActive`, а не на само число.
    const { userId, chartId } = await newAccount();
    await seedState('single_report не израсходован', userId, chartId);

    const rights = await entitlements.getEntitlements(userId);
    expect(rights.askPerDay).toBe(1);
    expect(await access.hasAccess(userId, 'ask')).toBe(false);
  });
});

describe('single_report: активация открывает разбор и гасится только на `ready`', () => {
  it('код на разбор → `hasAccess(report)` = true, `consumed_at` пуст', async () => {
    const { userId, chartId } = await newAccount();
    await codes.create({ kind: 'single_report', maxActivations: 5, code: 'SREP2222' });

    const activated = await codes.activate(userId, 'SREP2222');
    expect(activated.kind).toBe('single_report');

    const grant = await ctx.db.queryOne<{ kind: string; consumed_at: Date | null }>(
      `SELECT kind, consumed_at FROM grants WHERE user_id = $1`,
      [userId],
    );
    // H3 и H4 из диагностики: право не израсходовано при активации и его вид —
    // ровно тот, что в коде.
    expect(grant?.kind).toBe('single_report');
    expect(grant?.consumed_at).toBeNull();

    expect(await access.hasAccess(userId, 'report', { chartId })).toBe(true);
  });

  it('успешный разбор → право израсходовано, следующая карта снова платная', async () => {
    const first = await newAccount();
    await ctx.db.query(
      `INSERT INTO grants (user_id, kind, source) VALUES ($1, 'single_report', 'admin')`,
      [first.userId],
    );

    const created = await request(ctx.app.getHttpServer())
      .post('/api/v1/reports')
      .set(INIT_DATA_HEADER, initDataFor())
      .set('Idempotency-Key', 'grant-ready-1')
      .send({ chart_id: first.chartId, type: 'full' })
      .expect(202);

    await waitForStatus(created.body.report_id as string, 'ready');

    const grant = await waitForConsumption(first.userId);
    expect(grant).toBeDefined();
    expect(grant?.consumed_at).not.toBeNull();

    // Оплаченный разбор этой карты остаётся доступен (он куплен)…
    expect(await access.hasAccess(first.userId, 'report', { chartId: first.chartId })).toBe(true);

    // …а на второй карте права уже нет: заказ снова платный.
    const second = await newSecondChart();
    expect(await access.hasAccess(first.userId, 'report', { chartId: second })).toBe(false);
  });
});

describe('провал генерации не сжигает право', () => {
  it('failed → `consumed_at` пуст, право можно потратить снова', async () => {
    const failing = await createTestContext({
      astro: makeFakeAstro(),
      telegram: makeFakeTelegram(),
      llm: new FailingProvider(),
      env: { REPORT_BREAKER_ENABLED: '0' },
    });

    try {
      const response = await request(failing.app.getHttpServer())
        .post('/api/v1/charts')
        .set(INIT_DATA_HEADER, initDataFor(USER_ID_2))
        .send(BIRTH)
        .expect(201);

      const chartId = response.body.chart.chart_id as string;
      const user = await failing.db.queryOne<{ id: string }>(
        `SELECT id::text AS id FROM users WHERE telegram_id = $1`,
        [String(USER_ID_2)],
      );
      const userId = user?.id ?? '';

      await failing.db.query(
        `INSERT INTO grants (user_id, kind, source) VALUES ($1, 'single_report', 'admin')`,
        [userId],
      );

      const created = await request(failing.app.getHttpServer())
        .post('/api/v1/reports')
        .set(INIT_DATA_HEADER, initDataFor(USER_ID_2))
        .set('Idempotency-Key', 'grant-fail-1')
        .send({ chart_id: chartId, type: 'full' })
        .expect(202);

      const reportId = created.body.report_id as string;

      for (let attempt = 0; attempt < 300; attempt += 1) {
        const state = await failing.db.queryOne<{ status: string }>(
          `SELECT status FROM reports WHERE id = $1`,
          [reportId],
        );
        if (state?.status === 'failed') {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }

      const grant = await failing.db.queryOne<{ consumed_at: Date | null }>(
        `SELECT consumed_at FROM grants WHERE id IN (SELECT id FROM grants WHERE user_id = $1)`,
        [userId],
      );
      expect(grant?.consumed_at).toBeNull();
      expect(await failing.app.get(AccessService).hasAccess(userId, 'report', { chartId })).toBe(
        true,
      );
    } finally {
      await failing.close();
    }
  });
});

describe('двойное право: `all_access` + `single_report`', () => {
  it('расходуется `all_access`, разовое право остаётся', async () => {
    const { userId, chartId } = await newAccount();

    await ctx.db.query(
      `INSERT INTO grants (user_id, kind, source, days, starts_at, expires_at)
       VALUES ($1, 'all_access', 'partner', 14, now(), now() + interval '14 days')`,
      [userId],
    );
    await ctx.db.query(
      `INSERT INTO grants (user_id, kind, source) VALUES ($1, 'single_report', 'admin')`,
      [userId],
    );

    const created = await request(ctx.app.getHttpServer())
      .post('/api/v1/reports')
      .set(INIT_DATA_HEADER, initDataFor())
      .set('Idempotency-Key', 'both-rights-1')
      .send({ chart_id: chartId, type: 'full' })
      .expect(202);

    await waitForStatus(created.body.report_id as string, 'ready');

    const single = await ctx.db.queryOne<{ consumed_at: Date | null }>(
      `SELECT consumed_at FROM grants WHERE user_id = $1 AND kind = 'single_report'`,
      [userId],
    );
    // Разовое право не тронуто: `all_access` всё равно истечёт, а подаренный
    // разбор человек должен сохранить на потом.
    expect(single?.consumed_at).toBeNull();

    const rights = await entitlements.getGrantEntitlements(userId);
    expect(rights.singleReports).toBe(1);
  });
});

describe('держателю права не продают то, что у него есть', () => {
  it('`single_report` → `POST /billing/invoice` отказ, счёта и платежа нет', async () => {
    const { userId, chartId } = await newAccount();
    await ctx.db.query(
      `INSERT INTO grants (user_id, kind, source) VALUES ($1, 'single_report', 'admin')`,
      [userId],
    );

    const response = await request(ctx.app.getHttpServer())
      .post('/api/v1/billing/invoice')
      .set(INIT_DATA_HEADER, initDataFor())
      .send({ plan_code: 'one_149', chart_id: chartId })
      .expect(422);

    const body = response.body as { code: string; details: { reason: string } };
    expect(body.code).toBe('VALIDATION_FAILED');
    // Контракт 1.6.18 не менялся: переиспользуем существующую причину
    // «разбор уже есть», а не вводим новый код.
    expect(body.details.reason).toBe('report_already_owned');

    // Не только код ответа: в базе не должно остаться ни счёта, ни платежа.
    expect(await countInvoices(userId)).toBe(0);
    expect(await countPayments(userId)).toBe(0);
  });

  it('`all_access` активен → тот же отказ и те же нули в таблицах', async () => {
    const { userId, chartId } = await newAccount();
    await ctx.db.query(
      `INSERT INTO grants (user_id, kind, source, days, starts_at, expires_at)
       VALUES ($1, 'all_access', 'partner', 14, now(), now() + interval '14 days')`,
      [userId],
    );

    const response = await request(ctx.app.getHttpServer())
      .post('/api/v1/billing/invoice')
      .set(INIT_DATA_HEADER, initDataFor())
      .send({ plan_code: 'one_149', chart_id: chartId })
      .expect(422);

    expect((response.body as { details: { reason: string } }).details.reason).toBe(
      'report_already_owned',
    );
    expect(await countInvoices(userId)).toBe(0);
    expect(await countPayments(userId)).toBe(0);
  });

  it('истёкшее `all_access` покупку не блокирует', async () => {
    const { userId, chartId } = await newAccount();
    await ctx.db.query(
      `INSERT INTO grants (user_id, kind, source, days, starts_at, expires_at)
       VALUES ($1, 'all_access', 'partner', 14, now() - interval '15 days', now() - interval '1 day')`,
      [userId],
    );

    const response = await request(ctx.app.getHttpServer())
      .post('/api/v1/billing/invoice')
      .set(INIT_DATA_HEADER, initDataFor())
      .send({ plan_code: 'one_149', chart_id: chartId })
      .expect(201);

    expect((response.body as { plan_code: string }).plan_code).toBe('one_149');
  });
});

async function countInvoices(userId: string): Promise<number> {
  const row = await ctx.db.queryOne<{ count: number }>(
    `SELECT count(*)::int AS count FROM invoices WHERE user_id = $1`,
    [userId],
  );
  return row?.count ?? 0;
}

async function countPayments(userId: string): Promise<number> {
  const row = await ctx.db.queryOne<{ count: number }>(
    `SELECT count(*)::int AS count FROM payments WHERE user_id = $1`,
    [userId],
  );
  return row?.count ?? 0;
}

async function newSecondChart(): Promise<string> {
  const response = await request(ctx.app.getHttpServer())
    .post('/api/v1/charts')
    .set(INIT_DATA_HEADER, initDataFor())
    .send({ ...BIRTH, birth_time: '09:05', time_precision: 'exact' })
    .expect(201);

  return response.body.chart.chart_id as string;
}

async function waitForStatus(reportId: string, status: string): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const response = await request(ctx.app.getHttpServer())
      .get(`/api/v1/reports/${reportId}`)
      .set(INIT_DATA_HEADER, initDataFor());

    if (response.body.status === status) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  throw new Error(`разбор ${reportId} не дошёл до ${status}`);
}

async function waitForConsumption(userId: string): Promise<{ consumed_at: Date | null } | undefined> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const grant = await ctx.db.queryOne<{ consumed_at: Date | null }>(
      `SELECT consumed_at FROM grants WHERE user_id = $1 AND kind = 'single_report'`,
      [userId],
    );

    if (grant?.consumed_at !== null && grant?.consumed_at !== undefined) {
      return grant;
    }

    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  return undefined;
}
