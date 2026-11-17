import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { INIT_DATA_HEADER } from '../src/modules/auth/init-data';
import { planFromRow, type PlanRow } from '../src/modules/billing/plans.repository';
import {
  INVOICE_TITLE_MAX_CHARS,
  charsLength,
  parseArgs,
  validateInvoiceTitle,
} from '../scripts/set-plan-titles';
import { invoiceParamsViolation, XTR_SUBSCRIPTION_PERIOD_SECONDS } from '../src/modules/telegram/invoice-params';
import { createTestContext, truncateAll, type TestContext } from './test-app';
import { signInitData } from './init-data-fixture';
import { FICTIONAL_USER, TEST_BOT_TOKEN } from './test-env';
import { makeFakeTelegram, type FakeTelegram } from './fake-telegram';
import { makeFakeAstro } from './fake-astro';

/**
 * Итерация 26: название счёта — это данные, а не надежда.
 *
 * Итерация 25 чинила следствие: три тарифа не продавались, потому что их
 * название (35–36 символов) не влезало в лимит Bot API в 32 символа. Причина
 * осталась: в счёт уходило **название тарифа**, а оно нужно длинным и для
 * витрины, и для логов. Здесь проверяется, что роли разделены и что ошибка
 * данных не превращается в «502 от платёжной системы»:
 *   • в базе у каждого тарифа `invoice_title` в пределах 1–32 (и это держит
 *     `CHECK`, а не кодекс чести разработчика);
 *   • в `createInvoiceLink` уходит `invoice_title`, а не `paywall_title` и не
 *     `title`;
 *   • 33 символа не записываются в базу вообще;
 *   • битое название счёта — `409 plan_invoice_title_invalid`, а не `502`, и
 *     Bot API при этом не вызывается;
 *   • `test_1` — 30 дней, `test_report_1` — разовый, оба в лимите.
 */

let ctx: TestContext;
let telegram: FakeTelegram;

function initDataFor(): string {
  return signInitData({ botToken: TEST_BOT_TOKEN, user: FICTIONAL_USER });
}

interface PlanDbRowLite {
  readonly code: string;
  readonly invoice_title: string;
  readonly paywall_title: string;
  readonly title: string;
  readonly period_seconds: number | null;
  readonly kind: 'one_off' | 'subscription';
  readonly is_active: boolean;
}

async function readPlans(): Promise<readonly PlanDbRowLite[]> {
  return ctx.db.query<PlanDbRowLite>(
    `SELECT code, invoice_title, paywall_title, title, period_seconds, kind, is_active
       FROM plans ORDER BY sort, code`,
  );
}

async function createInvoice(planCode: string, chartId?: string): Promise<request.Response> {
  return request(ctx.app.getHttpServer())
    .post('/api/v1/billing/invoice')
    .set(INIT_DATA_HEADER, initDataFor())
    .send({ plan_code: planCode, ...(chartId === undefined ? {} : { chart_id: chartId }) });
}

/** Разовым товарам нужна карта — как в мини-аппе: без неё `422 chart_id`. */
async function createChart(): Promise<string> {
  const chart = await request(ctx.app.getHttpServer())
    .post('/api/v1/charts')
    .set(INIT_DATA_HEADER, initDataFor())
    .send({
      birth_date: '1994-05-17',
      birth_time: '14:20',
      time_precision: 'exact',
      birth_place: { name: 'Москва', country: 'RU', lat: 55.7558, lon: 37.6173, tz: 'Europe/Moscow' },
      consent: { accepted: true, version: '2026-11-10' },
    })
    .expect(201);

  return chart.body.chart.chart_id as string;
}

beforeAll(async () => {
  telegram = makeFakeTelegram();
  // Тестовые тарифы включены: половина смысла этой итерации — что `test_1`
  // действительно выставляется, а не «есть в базе».
  ctx = await createTestContext({
    telegram,
    astro: makeFakeAstro(),
    env: { PAYMENTS_TEST_PLANS: '1' },
  });
});

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  await truncateAll(ctx.db);
  telegram.invoiceCalls.length = 0;
  telegram.invoiceError = null;
});

describe('plans.invoice_title — данные, а не договорённость', () => {
  it('у каждого тарифа в базе название счёта 1–32 символа', async () => {
    const plans = await readPlans();

    expect(plans.length).toBeGreaterThanOrEqual(7);
    for (const plan of plans) {
      const length = charsLength(plan.invoice_title);
      expect(length, `${plan.code}: «${plan.invoice_title}»`).toBeGreaterThanOrEqual(1);
      expect(length, `${plan.code}: «${plan.invoice_title}»`).toBeLessThanOrEqual(INVOICE_TITLE_MAX_CHARS);
      // Лимит самого Bot API — тот же, что в `CHECK`: второго места, где
      // название может оказаться длинным, быть не должно.
      expect(
        invoiceParamsViolation({
          title: plan.invoice_title,
          description: 'x',
          payload: 'p',
          prices: [{ label: 'y', amount: 1 }],
        }),
      ).toBeNull();
    }
  });

  it('название тарифа и название счёта — разные строки, и длинный тариф не ломает счёт', async () => {
    const plans = await readPlans();
    const month = plans.find((plan) => plan.code === 'month_399');

    expect(month).toBeDefined();
    expect(month?.title).not.toBe(month?.invoice_title);
    expect(charsLength(month?.invoice_title ?? '')).toBeLessThanOrEqual(INVOICE_TITLE_MAX_CHARS);

    // Тариф, который на стенде владельца не продавался: `title` — 35 символов.
    // До итерации 26 именно он уходил в счёт, и Bot API отвечал 400. Такое
    // название для логов законно, поэтому лимит держит отдельная колонка.
    const longTitle = 'Разбор личности — подписка на месяц';
    expect(charsLength(longTitle)).toBeGreaterThan(INVOICE_TITLE_MAX_CHARS);
    expect(
      invoiceParamsViolation({
        title: longTitle,
        description: 'x',
        payload: 'p',
        prices: [{ label: 'y', amount: 1 }],
      }),
    ).toMatchObject({ field: 'title', limit: INVOICE_TITLE_MAX_CHARS });
  });

  it('название в 33 символа не записывается: схема не пропускает', async () => {
    const tooLong = 'я'.repeat(INVOICE_TITLE_MAX_CHARS + 1);

    // `varchar(32)` режет слишком длинную строку (`22001`), `CHECK` — пустую
    // (`23514`). Для нас важно одно: записать в базу название вне 1..32 нельзя
    // ни тем, ни другим путём.
    const rejected = await ctx.db
      .query(`UPDATE plans SET invoice_title = $1 WHERE code = 'month_399'`, [tooLong])
      .then(() => null)
      .catch((error: { code?: string }) => error.code ?? 'unknown');

    expect(rejected).toBe('22001');

    await expect(
      ctx.db.query(`UPDATE plans SET invoice_title = '' WHERE code = 'month_399'`),
    ).rejects.toMatchObject({ code: '23514' });

    const after = await readPlans();
    expect(after.find((plan) => plan.code === 'month_399')?.invoice_title).toBe('Подписка на месяц');
  });
});

describe('POST /billing/invoice — в счёт уходит invoice_title', () => {
  it('stub получает invoice_title, а не название тарифа', async () => {
    const plans = await readPlans();
    const chartId = await createChart();
    // Три роли счёта: месячная подписка, разовый разбор и тестовая подписка.
    // Больше нельзя: антифрод разрешает три счёта в час на человека, и это
    // правило итерации 24 трогать не за чем.
    const sellable = plans.filter(
      (plan) => plan.code === 'month_399' || plan.code === 'one_149' || plan.code === 'test_1',
    );

    expect(sellable).toHaveLength(3);

    for (const plan of sellable) {
      telegram.invoiceCalls.length = 0;
      const response = await createInvoice(plan.code, chartId);

      expect(response.status, `${plan.code}: ${JSON.stringify(response.body)}`).toBe(201);
      const call = telegram.invoiceCalls.at(-1);
      expect(call, plan.code).toBeDefined();
      // Источник правды — колонка `invoice_title`, а не название тарифа.
      expect(call?.title).toBe(plan.invoice_title);
      expect(call?.title.length).toBeLessThanOrEqual(INVOICE_TITLE_MAX_CHARS);
      if (plan.title !== plan.invoice_title) {
        expect(call?.title).not.toBe(plan.title);
      }
    }
  });

  it('битое название счёта → 409 plan_invoice_title_invalid, не 502, и без вызова Bot API', async () => {
    const row = await ctx.db.queryOne<Record<string, unknown>>(
      `SELECT * FROM plans WHERE code = 'month_399'`,
    );
    expect(row).not.toBeNull();

    // Строку такой схема не пропустит — и не должна. Проверяем ответ API на
    // случай, когда битые данные всё-таки оказались в каталоге (старая база,
    // правка мимо CHECK, будущий импорт): человек не должен видеть «внутреннюю
    // ошибку» и не должен получать 502 от Telegram, которого мы не звали.
    const broken: PlanRow = { ...planFromRow(row as never), invoiceTitle: 'я'.repeat(33) };
    const brokenCtx = await createTestContext({
      telegram,
      astro: makeFakeAstro(),
      plans: {
        getPlan: () => Promise.resolve(broken),
        listPlans: () => Promise.resolve([broken]),
        getSubscriptionPlan: () => Promise.resolve(null),
      },
    });

    try {
      telegram.invoiceCalls.length = 0;
      const response = await request(brokenCtx.app.getHttpServer())
        .post('/api/v1/billing/invoice')
        .set(INIT_DATA_HEADER, initDataFor())
        .send({ plan_code: 'month_399' });

      expect(response.status).toBe(409);
      expect(response.body).toMatchObject({
        code: 'CONFLICT',
        details: { reason: 'plan_invoice_title_invalid' },
      });
      expect(response.body.message).toContain('название счёта');
      // Ключевое: до Telegram дело не дошло — значит и 502 взяться неоткуда.
      expect(telegram.invoiceCalls).toHaveLength(0);
    } finally {
      await brokenCtx.close();
    }
  });
});

describe('test_1 и test_report_1 — проверка оплаты, которая действительно выставится', () => {
  it('test_1 — подписка на 30 дней, как требует Bot API для звёздных подписок', async () => {
    const plans = await readPlans();
    const testSubscription = plans.find((plan) => plan.code === 'test_1');

    expect(testSubscription).toBeDefined();
    expect(testSubscription?.kind).toBe('subscription');
    expect(testSubscription?.period_seconds).toBe(XTR_SUBSCRIPTION_PERIOD_SECONDS);
    expect(testSubscription?.period_seconds).toBe(2_592_000);
  });

  it('test_report_1 остаётся разовым и в лимите названия', async () => {
    const plans = await readPlans();
    const testReport = plans.find((plan) => plan.code === 'test_report_1');

    expect(testReport).toBeDefined();
    expect(testReport?.kind).toBe('one_off');
    expect(testReport?.period_seconds).toBeNull();
    expect(charsLength(testReport?.invoice_title ?? '')).toBeLessThanOrEqual(INVOICE_TITLE_MAX_CHARS);
  });
});

describe('pnpm plans:set-titles — та же валидация, что и в схеме', () => {
  it('принимает название в лимите и обрезает пробелы', () => {
    expect(parseArgs(['--code=month_399', '--title=  Подписка на месяц  '])).toEqual({
      code: 'month_399',
      title: 'Подписка на месяц',
    });
    expect(parseArgs(['--code', 'month_399', '--title', 'Карта года'])).toEqual({
      code: 'month_399',
      title: 'Карта года',
    });
  });

  it('33 символа — ошибка с подсказкой, а не запись в базу', () => {
    const tooLong = 'Разбор личности: месяц — полный доступ';
    expect(charsLength(tooLong)).toBeGreaterThan(INVOICE_TITLE_MAX_CHARS);

    expect(() => validateInvoiceTitle(tooLong)).toThrow(/32/);
    expect(() => parseArgs(['--code=month_399', `--title=${tooLong}`])).toThrow(/32/);
  });

  it('пустое название и отсутствие аргументов отклоняются', () => {
    expect(() => validateInvoiceTitle('   ')).toThrow(/пустым/);
    expect(() => parseArgs(['--code=month_399'])).toThrow(/--title/);
    expect(() => parseArgs(['--title=Тест'])).toThrow(/--code/);
  });

  it('длина считается в символах, а не в байтах UTF-8', () => {
    // «Подписка на месяц» — 17 символов и 32 байта: Bot API считает символы,
    // и именно на этой разнице раньше путались «влезает / не влезает».
    expect(charsLength('Подписка на месяц')).toBe(17);
    expect(Buffer.byteLength('Подписка на месяц', 'utf8')).toBe(32);
  });
});
