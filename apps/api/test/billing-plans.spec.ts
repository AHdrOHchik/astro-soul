import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { PLAN_CODES, TEST_PLAN_CODES } from '@astro-soul/shared';
import { INIT_DATA_HEADER } from '../src/modules/auth/init-data';
import { createTestContext, truncateAll, type TestContext } from './test-app';
import { signInitData } from './init-data-fixture';
import { FICTIONAL_USER, TEST_BOT_TOKEN } from './test-env';
import { makeFakeTelegram, type FakeTelegram } from './fake-telegram';
import { makeFakeAstro } from './fake-astro';

/**
 * `GET /billing/plans` — витрина, которую знает сервер, а не клиент.
 *
 * Проверяется главное обещание: при выключенном флаге тестовых тарифов нет в
 * ответе **никаким** способом (ни планом, ни полем, ни подстрокой), а при
 * включённом — они есть, помечены `test: true` и по ним создаётся счёт.
 * Второе — что витрина совпадает с общей таблицей цен, а не с копией.
 */

const BIRTH = {
  birth_date: '1994-05-17',
  birth_time: '14:20',
  time_precision: 'exact',
  birth_place: { name: 'Москва', country: 'RU', lat: 55.7558, lon: 37.6173, tz: 'Europe/Moscow' },
  consent: { accepted: true, version: '2026-11-10' },
};

interface Offer {
  readonly plan_code: string;
  readonly kind: 'subscription' | 'one_off';
  readonly stars: number;
  readonly period_sec: number | null;
  readonly title: string;
  readonly subtitle: string;
  readonly includes: readonly string[];
  readonly test: boolean;
}

let offCtx: TestContext;
let onCtx: TestContext;
let telegram: FakeTelegram;

function initDataFor(user: Record<string, unknown> = FICTIONAL_USER): string {
  return signInitData({ botToken: TEST_BOT_TOKEN, user });
}

async function fetchPlans(ctx: TestContext): Promise<{ body: { plans: Offer[] }; headers: Record<string, string> }> {
  const response = await request(ctx.app.getHttpServer())
    .get('/api/v1/billing/plans')
    .set(INIT_DATA_HEADER, initDataFor())
    .expect(200);

  return { body: response.body, headers: response.headers };
}

beforeAll(async () => {
  telegram = makeFakeTelegram();

  // Сначала витрина с выключенным флагом: переменная окружения читается при
  // сборке приложения, поэтому контексты создаются в явном порядке и с явным
  // значением, а не «что осталось от предыдущего теста».
  delete process.env['PAYMENTS_TEST_PLANS'];
  offCtx = await createTestContext({
    astro: makeFakeAstro(),
    telegram,
    env: { ADMIN_TG_ID: '777000111' },
  });

  onCtx = await createTestContext({
    astro: makeFakeAstro(),
    telegram,
    env: { PAYMENTS_TEST_PLANS: '1', ADMIN_TG_ID: '777000111' },
  });
});

afterAll(async () => {
  await offCtx.close();
  await onCtx.close();
  delete process.env['PAYMENTS_TEST_PLANS'];
  delete process.env['ADMIN_TG_ID'];
});

beforeEach(async () => {
  await truncateAll(offCtx.db);
  telegram.invoiceCalls.length = 0;
});

describe('GET /api/v1/billing/plans при выключенном флаге', () => {
  it('отдаёт ровно каталог: шесть тарифов в порядке пейволла', async () => {
    const { body } = await fetchPlans(offCtx);

    expect(body.plans.map((plan) => plan.plan_code)).toEqual([...PLAN_CODES]);
    expect(body.plans.every((plan) => plan.test === false)).toBe(true);
  });

  it('не содержит тестовых тарифов ни планом, ни подстрокой', async () => {
    const { body } = await fetchPlans(offCtx);
    const raw = JSON.stringify(body);

    // Не «отфильтрованы в вёрстке», а физически отсутствуют в ответе.
    for (const code of TEST_PLAN_CODES) {
      expect(raw).not.toContain(code);
    }
    expect(raw).not.toContain('PAYMENTS_TEST_PLANS');
    expect(raw).not.toContain('test:true');
  });

  it('цены, периоды и состав берутся из общей таблицы планов', async () => {
    const { body } = await fetchPlans(offCtx);

    const report = body.plans.find((plan) => plan.plan_code === 'one_149');
    expect(report).toMatchObject({ kind: 'one_off', stars: 149, period_sec: null, test: false });
    expect(report?.includes).toEqual(['Все главы разбора по этой карте', 'PDF-файл']);

    const month = body.plans.find((plan) => plan.plan_code === 'month_399');
    expect(month).toMatchObject({ kind: 'subscription', stars: 399, period_sec: 2_592_000 });
    expect(month?.includes).toEqual([
      'Полные прогнозы каждый день',
      '5 вопросов карте в день',
      'Совместимость раз в месяц',
    ]);

    const year = body.plans.find((plan) => plan.plan_code === 'year_2990');
    expect(year?.includes).toContain('Карта года');

    for (const plan of body.plans) {
      expect(plan.title.length).toBeGreaterThan(0);
      expect(plan.subtitle.length).toBeGreaterThan(0);
      expect(plan.includes.length).toBeGreaterThan(0);
      // Период есть ровно у подписки: по нему клиент решает, как открывать счёт.
      if (plan.kind === 'subscription') {
        expect(typeof plan.period_sec).toBe('number');
        expect(plan.period_sec).toBeGreaterThan(0);
      } else {
        expect(plan.period_sec).toBeNull();
      }
    }
  });

  it('запрещает кэширование: список зависит от окружения процесса', async () => {
    const { headers } = await fetchPlans(offCtx);

    expect(headers['cache-control']).toBe('no-store');
  });

  it('без initData не отдаётся: витрина часть приложения, а не публичная страница', async () => {
    await request(offCtx.app.getHttpServer()).get('/api/v1/billing/plans').expect(401);
  });

  it('метрики показывают, что тестовые тарифы выключены', async () => {
    const response = await request(offCtx.app.getHttpServer())
      .get('/api/v1/admin/metrics')
      .set(INIT_DATA_HEADER, initDataFor())
      .expect(200);

    expect(response.body.test_plans_active).toBe(false);
  });
});

describe('GET /api/v1/billing/plans при включённом флаге', () => {
  it('добавляет оба тестовых тарифа после каталога, с test: true', async () => {
    const { body } = await fetchPlans(onCtx);

    expect(body.plans.map((plan) => plan.plan_code)).toEqual([...PLAN_CODES, ...TEST_PLAN_CODES]);

    const report = body.plans.find((plan) => plan.plan_code === 'test_report_1');
    expect(report).toMatchObject({ kind: 'one_off', stars: 1, period_sec: null, test: true });
    expect(report?.title).toBe('Тестовый разбор');

    const subscription = body.plans.find((plan) => plan.plan_code === 'test_1');
    expect(subscription).toMatchObject({ kind: 'subscription', stars: 1, period_sec: 604_800, test: true });

    // Каталог не сдвинулся: тестовые — добавка, а не замена.
    expect(body.plans.filter((plan) => !plan.test).map((plan) => plan.plan_code)).toEqual([...PLAN_CODES]);
  });

  it('по тестовым кодам из витрины создаётся счёт за 1 звезду', async () => {
    const { body } = await fetchPlans(onCtx);
    const offered = body.plans.find((plan) => plan.plan_code === 'test_report_1');

    const chart = await request(onCtx.app.getHttpServer())
      .post('/api/v1/charts')
      .set(INIT_DATA_HEADER, initDataFor())
      .send(BIRTH)
      .expect(201);

    const invoice = await request(onCtx.app.getHttpServer())
      .post('/api/v1/billing/invoice')
      .set(INIT_DATA_HEADER, initDataFor())
      // Ровно то, что прислала витрина: клиент не подставляет код сам.
      .send({ plan_code: offered?.plan_code, chart_id: chart.body.chart.chart_id })
      .expect(201);

    expect(invoice.body).toMatchObject({ plan_code: 'test_report_1', stars: 1, is_subscription: false });
    expect(telegram.invoiceCalls[0]?.prices).toEqual([{ label: 'Тест-разбор', amount: 1 }]);
    // Разовый товар: `subscription_period` не передаётся, иначе Telegram
    // превратил бы разбор в третью подписку.
    expect(telegram.invoiceCalls[0]?.subscriptionPeriod).toBeUndefined();
  });

  it('метрики видят включённый флаг: «включил и забыл» видно сразу', async () => {
    const response = await request(onCtx.app.getHttpServer())
      .get('/api/v1/admin/metrics')
      .set(INIT_DATA_HEADER, initDataFor())
      .expect(200);

    expect(response.body.test_plans_active).toBe(true);
    expect(response.body.test_payments_30d).toBe(0);
  });
});
