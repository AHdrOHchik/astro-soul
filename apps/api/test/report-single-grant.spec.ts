import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { INIT_DATA_HEADER } from '../src/modules/auth/init-data';
import { makeFakeAstro } from './fake-astro';
import { createTestContext, truncateAll, type TestContext } from './test-app';
import { signInitData } from './init-data-fixture';
import { FICTIONAL_USER, TEST_BOT_TOKEN } from './test-env';
import { makeFakeTelegram } from './fake-telegram';
import type { LlmProvider, LlmRequest, LlmResponse } from '../src/modules/llm/llm.client';

/**
 * Одноразовое право на разбор: когда оно сгорает (итерация 43, долг 7.2).
 *
 * Раньше `single_report` списывался **на заказе**: `AccessService.hasAccess(...,
 * {consume: true})` гасил право до того, как модель успевала ответить. Любой
 * провал генерации — формат, запрещённая тема, недоступный провайдер, брейкер —
 * означал, что человек потратил подаренное право на нашу ошибку.
 *
 * Теперь право списывается на `ready` (`ReportsService.settleGrantFor`). Тесты
 * проверяют обе стороны: провал — право цело, успех — право израсходовано, и
 * подписчик с подарком подарок не теряет.
 */

const BIRTH = {
  birth_date: '1994-05-17',
  birth_time: '14:20',
  time_precision: 'exact',
  birth_place: { name: 'Москва', country: 'RU', lat: 55.7558, lon: 37.6173, tz: 'Europe/Moscow' },
  consent: { accepted: true, version: '2026-11-10' },
};

/** Провайдер, который всегда падает: так выглядит сломанная модель или сеть. */
class FailingProvider implements LlmProvider {
  readonly name = 'failing-stub';

  complete(_input: LlmRequest): Promise<LlmResponse> {
    void _input;
    return Promise.reject(new Error('provider: соединение закрыто'));
  }
}

/** Провайдер, который собирает разбор целиком (план + семь глав). */
class ReadyProvider implements LlmProvider {
  readonly name = 'ready-stub';
  calls = 0;

  complete(input: LlmRequest): Promise<LlmResponse> {
    this.calls += 1;
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

    const sentences = [
      'Ты выбираешь устойчивый темп и редко меняешь его под внешним давлением.',
      'Там, где другие торопятся, ты сначала проверяешь основание и только потом идёшь.',
      'Это выглядит медленным со стороны и оказывается быстрым по результату.',
      'Твоя сила в повторяемости: ты возвращаешься к начатому и доводишь до конца.',
      'Спешка выбивает тебя из ритма сильнее, чем объём работы.',
      'Ты замечаешь детали, которые остальные пропускают, и это экономит тебе месяцы.',
      'Ясность для тебя важнее внешнего одобрения, и это видно по решениям.',
    ];
    return Promise.resolve(this.answer(sentences.join(' ')));
  }

  private answer(content: string): LlmResponse {
    return {
      content,
      model: this.name,
      usage: { promptTokens: 800, completionTokens: 200, totalTokens: 1_000, costRub: 0.3 },
    };
  }
}

function initDataFor(id: number = FICTIONAL_USER.id): string {
  return signInitData({ botToken: TEST_BOT_TOKEN, user: { ...FICTIONAL_USER, id } });
}

async function withProvider(provider: LlmProvider): Promise<TestContext> {
  return createTestContext({
    astro: makeFakeAstro(),
    telegram: makeFakeTelegram(),
    llm: provider,
    env: { REPORT_BREAKER_ENABLED: '0' },
  });
}

async function userWithChart(ctx: TestContext, id: number = FICTIONAL_USER.id): Promise<{
  chartId: string;
  userId: string;
}> {
  const response = await request(ctx.app.getHttpServer())
    .post('/api/v1/charts')
    .set(INIT_DATA_HEADER, initDataFor(id))
    .send(BIRTH)
    .expect(201);

  const user = await ctx.db.queryOne<{ id: string }>(`SELECT id FROM users WHERE telegram_id = $1`, [
    BigInt(id).toString(),
  ]);

  return { chartId: response.body.chart.chart_id as string, userId: user?.id ?? '' };
}

/** Подарок: одноразовое право, выданное админом (не код партнёра, не покупка). */
async function giveSingleReport(userId: string): Promise<string> {
  const row = await ctxReport.db.queryOne<{ id: string }>(
    `INSERT INTO grants (user_id, kind, source) VALUES ($1, 'single_report', 'admin')
     RETURNING id::text AS id`,
    [userId],
  );
  return row?.id ?? '';
}

let ctxReport: TestContext;

async function waitForStatus(
  ctx: TestContext,
  reportId: string,
  status: string,
  id: number = FICTIONAL_USER.id,
): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const response = await request(ctx.app.getHttpServer())
      .get(`/api/v1/reports/${reportId}`)
      .set(INIT_DATA_HEADER, initDataFor(id));

    if (response.body.status === status) {
      return response.body as Record<string, unknown>;
    }

    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  throw new Error(`разбор ${reportId} не дошёл до ${status}`);
}

/**
 * Право списывается **после** сохранения `ready` (сначала текст, потом расход:
 * ошибка расхода не должна превращать готовый разбор в `failed`), поэтому
 * тест ждёт расхода, а не читает строку сразу после смены статуса.
 */
async function waitForConsumption(
  ctx: TestContext,
  grantId: string,
): Promise<{ consumed_at: Date | null } | undefined> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const grant = await ctx.db.queryOne<{ consumed_at: Date | null }>(
      `SELECT consumed_at FROM grants WHERE id = $1`,
      [grantId],
    );

    if (grant?.consumed_at !== null && grant?.consumed_at !== undefined) {
      return grant;
    }

    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  return undefined;
}

function order(ctx: TestContext, chartId: string, key: string, id: number = FICTIONAL_USER.id) {
  return request(ctx.app.getHttpServer())
    .post('/api/v1/reports')
    .set(INIT_DATA_HEADER, initDataFor(id))
    .set('Idempotency-Key', key)
    .send({ chart_id: chartId, type: 'full' });
}

describe('провал генерации не сжигает одноразовое право', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await withProvider(new FailingProvider());
    ctxReport = ctx;
  });

  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(async () => {
    await truncateAll(ctx.db);
  });

  it('failed → `consumed_at` остаётся NULL, права в `entitlements` нет', async () => {
    const fixture = await userWithChart(ctx);
    const grantId = await giveSingleReport(fixture.userId);

    const created = await order(ctx, fixture.chartId, 'fail-key').expect(202);
    const reportId = created.body.report_id as string;

    await waitForStatus(ctx, reportId, 'failed');

    const grant = await ctx.db.queryOne<{ consumed_at: Date | null }>(
      `SELECT consumed_at FROM grants WHERE id = $1`,
      [grantId],
    );
    expect(grant?.consumed_at).toBeNull();

    // И строка доступа не появилась: «право израсходовано» и «доступ выдан» —
    // одно и то же событие, и оно не должно случаться на провале.
    const entitlements = await ctx.db.query(
      `SELECT 1 FROM entitlements WHERE user_id = $1 AND kind = 'report'`,
      [fixture.userId],
    );
    expect(entitlements).toHaveLength(0);
  });

  it('после провала право можно потратить снова: повторный заказ проходит', async () => {
    const fixture = await userWithChart(ctx);
    await giveSingleReport(fixture.userId);

    const first = await order(ctx, fixture.chartId, 'fail-key-2').expect(202);
    await waitForStatus(ctx, first.body.report_id as string, 'failed');

    // Право цело — второй заказ не получает 402.
    await order(ctx, fixture.chartId, 'fail-key-3').expect(202);
  });
});

describe('успех списывает право один раз', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await withProvider(new ReadyProvider());
    ctxReport = ctx;
  });

  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(async () => {
    await truncateAll(ctx.db);
  });

  it('ready → `consumed_at` заполнен и `is_paid` в ответе', async () => {
    const fixture = await userWithChart(ctx);
    const grantId = await giveSingleReport(fixture.userId);

    const created = await order(ctx, fixture.chartId, 'ready-key').expect(202);
    const ready = await waitForStatus(ctx, created.body.report_id as string, 'ready');

    const grant = await waitForConsumption(ctx, grantId);
    expect(grant?.consumed_at).not.toBeNull();

    // `is_paid` считается по `entitlements`, которая материализуется вместе с
    // расходом: иначе готовый подаренный разбор выглядел бы неоплаченным.
    expect(ready['is_paid']).toBe(true);
  });

  it('подписчик с подарком подарок не теряет', async () => {
    const fixture = await userWithChart(ctx);
    await ctx.db.query(
      `INSERT INTO subscriptions (user_id, plan, status, expires_at)
       VALUES ($1, 'month', 'active', now() + interval '20 days')`,
      [fixture.userId],
    );
    const grantId = await giveSingleReport(fixture.userId);

    const created = await order(ctx, fixture.chartId, 'sub-key').expect(202);
    await waitForStatus(ctx, created.body.report_id as string, 'ready');
    // Даём расходу шанс случиться: тест проверяет, что его **нет**, а не что
    // он не успел.
    await new Promise((resolve) => setTimeout(resolve, 150));

    const grant = await ctx.db.queryOne<{ consumed_at: Date | null }>(
      `SELECT consumed_at FROM grants WHERE id = $1`,
      [grantId],
    );
    // Разбор уже оплачен подпиской — подарок остаётся на будущее. Это то же
    // правило, что в итерации 39 починили для совместимости.
    expect(grant?.consumed_at).toBeNull();
  });
});
