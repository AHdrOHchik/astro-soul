import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { INIT_DATA_HEADER } from '../src/modules/auth/init-data';
import { AccessService } from '../src/modules/entitlements/access.service';
import { makeFakeAstro } from './fake-astro';
import { createTestContext, truncateAll, type TestContext } from './test-app';
import { signInitData } from './init-data-fixture';
import { FICTIONAL_USER, TEST_BOT_TOKEN } from './test-env';
import { makeFakeTelegram } from './fake-telegram';

/**
 * `Me.report_access` — контракт 1.6.19 (round45, задачи 1–4).
 *
 * Диагноз: вопрос «можно ли человеку разбор» решался в двух местах и по-разному.
 * `hasAccess` смотрел на оплаченную карту, «всё включено» и подаренный разбор;
 * `Me` — на флаг `entitlements.full_report`, который поднимался в ветке «всё
 * включено» (round44) при `full_report_chart_id: null`. Итог: клиент показывал
 * одну картину, заказ отвечал другую (`402 report_not_paid` или, наоборот,
 * «оплачено», хотя платить надо).
 *
 * Что проверяется здесь:
 *   • шесть состояний аккаунта × (`/me` и `POST /billing/invoice`) — ответы
 *     обязаны согласовываться: `available: true` ⇒ ни одного счёта и `422
 *     report_already_owned`; `available: false` ⇒ счёт создаётся;
 *   • приоритет источников `purchased → all_access → single_report`;
 *   • отказ в счёте не оставляет **ни одной** строки в `invoices`/`payments`;
 *   • `chart = null` не роняет ни `/me`, ни заказ.
 *
 * Почему проверка идёт через HTTP, а не через сервис: дефект был именно в
 * несогласованности двух ответов. Тест, который спрашивает один сервис дважды,
 * такую рассинхронизацию не увидит by construction.
 */

const BIRTH = {
  birth_date: '1994-05-17',
  birth_time: '14:20',
  time_precision: 'exact',
  birth_place: { name: 'Москва', country: 'RU', lat: 55.7558, lon: 37.6173, tz: 'Europe/Moscow' },
  consent: { accepted: true, version: '2026-11-10' },
};

/** План разового разбора из сида (`one_149`) — тот же, что покупает человек. */
const REPORT_PLAN = 'one_149';

const USER_ID = 445_100_001;

type ReportAccessBody = {
  available: boolean;
  source: 'purchased' | 'all_access' | 'single_report' | null;
  expires_at: string | null;
  chart_id: string | null;
};

type MeBody = {
  chart_id: string | null;
  report_access?: ReportAccessBody;
  entitlements: { full_report: boolean; full_report_chart_id: string | null };
};

type State =
  | 'ничего'
  | 'разбор оплачен на эту карту'
  | 'разбор оплачен на другую карту'
  | 'all_access действует'
  | 'single_report не израсходован'
  | 'all_access истёк';

interface Expectation {
  readonly available: boolean;
  readonly source: ReportAccessBody['source'];
  /** `chart_id` в `report_access` — замаскированный ожидаемый вид. */
  readonly chartId: 'current' | 'other' | null;
  readonly fullReport: boolean;
  readonly fullReportChartId: 'current' | 'other' | null;
}

const EXPECTED: Readonly<Record<State, Expectation>> = {
  'ничего': { available: false, source: null, chartId: null, fullReport: false, fullReportChartId: null },
  'разбор оплачен на эту карту': {
    available: true,
    source: 'purchased',
    chartId: 'current',
    fullReport: true,
    fullReportChartId: 'current',
  },
  // Покупка одна: она не открывает разборы по другим картам (это деньги).
  'разбор оплачен на другую карту': {
    available: false,
    source: null,
    chartId: null,
    fullReport: true,
    fullReportChartId: 'other',
  },
  'all_access действует': {
    available: true,
    source: 'all_access',
    chartId: null,
    // Право есть, покупки нет: `full_report` — про покупку, а не про право.
    fullReport: false,
    fullReportChartId: null,
  },
  'single_report не израсходован': {
    available: true,
    source: 'single_report',
    chartId: null,
    fullReport: false,
    fullReportChartId: null,
  },
  'all_access истёк': {
    available: false,
    source: null,
    chartId: null,
    fullReport: false,
    fullReportChartId: null,
  },
};

let ctx: TestContext;
let access: AccessService;

function initDataFor(id: number = USER_ID): string {
  return signInitData({ botToken: TEST_BOT_TOKEN, user: { ...FICTIONAL_USER, id } });
}

interface Account {
  readonly userId: string;
  readonly chartId: string;
  /** Вторая карта — для состояния «оплачено на другую карту». */
  readonly otherChartId: string;
}

async function newAccount(id: number = USER_ID): Promise<Account> {
  const first = await request(ctx.app.getHttpServer())
    .post('/api/v1/charts')
    .set(INIT_DATA_HEADER, initDataFor(id))
    .send(BIRTH)
    .expect(201);

  const second = await request(ctx.app.getHttpServer())
    .post('/api/v1/charts')
    .set(INIT_DATA_HEADER, initDataFor(id))
    .send({ ...BIRTH, birth_date: '1991-02-03', birth_time: '06:40' })
    .expect(201);

  const user = await ctx.db.queryOne<{ id: string }>(
    `SELECT id::text AS id FROM users WHERE telegram_id = $1`,
    [String(id)],
  );

  return {
    userId: user?.id ?? '',
    // «Текущая» карта в `/me` — последняя созданная: `users.chart_id` ведёт на неё.
    chartId: second.body.chart.chart_id as string,
    otherChartId: first.body.chart.chart_id as string,
  };
}

/** Состояние — прямо в таблицах: матрица про дверь, а не про выдачу кодов. */
async function seedState(state: State, account: Account): Promise<void> {
  const { userId, chartId, otherChartId } = account;

  switch (state) {
    case 'ничего':
      return;
    case 'разбор оплачен на эту карту':
      await ctx.db.query(
        `INSERT INTO entitlements (user_id, kind, chart_id, status) VALUES ($1, 'report', $2, 'active')`,
        [userId, chartId],
      );
      await readyReport(userId, chartId, 'ready-current');
      return;
    case 'разбор оплачен на другую карту':
      await ctx.db.query(
        `INSERT INTO entitlements (user_id, kind, chart_id, status) VALUES ($1, 'report', $2, 'active')`,
        [userId, otherChartId],
      );
      await readyReport(userId, otherChartId, 'ready-other');
      return;
    case 'all_access действует':
      await ctx.db.query(
        `INSERT INTO grants (user_id, kind, source, days, starts_at, expires_at)
         VALUES ($1, 'all_access', 'partner', 14, now(), now() + interval '14 days')`,
        [userId],
      );
      return;
    case 'single_report не израсходован':
      await ctx.db.query(
        `INSERT INTO grants (user_id, kind, source) VALUES ($1, 'single_report', 'admin')`,
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
  }
}

async function readyReport(userId: string, chartId: string, key: string): Promise<void> {
  await ctx.db.query(
    `INSERT INTO reports (user_id, chart_id, kind, status, idempotency_key, chart_hash,
                          model, prompt_version, report_structure_version, chart_facts_version)
     VALUES ($1, $2, 'report', 'ready', $3, 'hash', 'stub', 'p1', 's1', 'c1')`,
    [userId, chartId, key],
  );
}

async function readMe(): Promise<MeBody> {
  const response = await request(ctx.app.getHttpServer())
    .get('/api/v1/me')
    .set(INIT_DATA_HEADER, initDataFor())
    .expect(200);

  return response.body as MeBody;
}

async function countBillingRows(userId: string): Promise<{ invoices: number; payments: number }> {
  const rows = await ctx.db.queryOne<{ invoices: number; payments: number }>(
    `SELECT
       (SELECT count(*)::int FROM invoices WHERE user_id = $1) AS invoices,
       (SELECT count(*)::int FROM payments WHERE user_id = $1) AS payments`,
    [userId],
  );

  return { invoices: rows?.invoices ?? -1, payments: rows?.payments ?? -1 };
}

function invoiceCall(chartId: string | null): request.Test {
  return request(ctx.app.getHttpServer())
    .post('/api/v1/billing/invoice')
    .set(INIT_DATA_HEADER, initDataFor())
    .send({ plan_code: REPORT_PLAN, chart_id: chartId });
}

beforeAll(async () => {
  ctx = await createTestContext({ astro: makeFakeAstro(), telegram: makeFakeTelegram() });
  access = ctx.app.get(AccessService);
});

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  await truncateAll(ctx.db);
});

describe('1.6.19: /me.report_access и заказ согласованы в шести состояниях', () => {
  for (const state of Object.keys(EXPECTED) as State[]) {
    const expected = EXPECTED[state];

    it(`${state}: /me отдаёт available=${String(expected.available)}, source=${String(expected.source)}`, async () => {
      const account = await newAccount();
      await seedState(state, account);

      const me = await readMe();
      const reportAccess = me.report_access;

      // Поле необязательное в контракте, но сервер обязан его отдавать всегда:
      // иначе новый клиент не отличит «права нет» от «старый сервер».
      expect(reportAccess).toBeDefined();
      if (reportAccess === undefined) {
        return;
      }

      expect(reportAccess.available).toBe(expected.available);
      expect(reportAccess.source).toBe(expected.source);

      const wantedChart =
        expected.chartId === 'current'
          ? account.chartId
          : expected.chartId === 'other'
            ? account.otherChartId
            : null;
      expect(reportAccess.chart_id).toBe(wantedChart);

      // «Всё включено» — единственный источник со сроком.
      if (expected.source === 'all_access') {
        expect(reportAccess.expires_at).not.toBeNull();
      } else {
        expect(reportAccess.expires_at).toBeNull();
      }

      // `full_report` отвечает на другой вопрос — «есть ли покупка/готовый
      // разбор», и не участвует в решении доступа.
      expect(me.entitlements.full_report).toBe(expected.fullReport);
      expect(me.entitlements.full_report_chart_id).toBe(
        expected.fullReportChartId === 'current'
          ? account.chartId
          : expected.fullReportChartId === 'other'
            ? account.otherChartId
            : null,
      );

      // То же решение принимает дверь — иначе `/me` и заказ разойдутся.
      const byDoor = await access.reportAccess(account.userId, { chartId: account.chartId });
      expect(byDoor.available).toBe(expected.available);
      expect(byDoor.source).toBe(expected.source);
    });

    it(`${state}: отказ/счёт в биллинге совпадает с report_access, лишних строк нет`, async () => {
      const account = await newAccount();
      await seedState(state, account);

      const me = await readMe();
      const available = me.report_access?.available ?? false;
      const before = await countBillingRows(account.userId);

      const response = await invoiceCall(account.chartId);

      const after = await countBillingRows(account.userId);

      if (available) {
        // Право есть — платить не за что. Код прежний (1.6.18): 422
        // VALIDATION_FAILED с причиной `report_already_owned`, новых кодов нет.
        expect(response.status).toBe(422);
        expect(response.body.code).toBe('VALIDATION_FAILED');
        expect(response.body.details.reason).toBe('report_already_owned');

        // Главное требование задачи 4: отказ не оставляет следов, по которым
        // человек потом «оплатит» уже оплаченное.
        expect(after).toEqual(before);
        expect(after.invoices).toBe(0);
        expect(after.payments).toBe(0);
      } else {
        // Права нет — счёт законен. Отказ здесь означал бы «кнопка открыта, а
        // заплатить нельзя» — вторую половину того же дефекта.
        expect(response.status).toBe(201);
        expect(response.body.plan_code).toBe(REPORT_PLAN);
        expect(after.invoices).toBe(before.invoices + 1);
        // Строка `payments` появляется на оплате, а не на счёте: счёт сам
        // денег не двигает, и это единственное, что здесь можно утверждать.
        expect(after.payments).toBe(before.payments);
      }
    });
  }

  it('порядок источников: purchased → all_access → single_report', async () => {
    // Все три источника сразу. Приоритет не косметика: `single_report` —
    // расходуемое право, и если доступ считался бы им, «всё включено» + подарок
    // сжигали бы подарок раньше времени.
    const account = await newAccount();
    await seedState('single_report не израсходован', account);
    await seedState('all_access действует', account);
    await ctx.db.query(
      `INSERT INTO entitlements (user_id, kind, chart_id, status) VALUES ($1, 'report', $2, 'active')`,
      [account.userId, account.chartId],
    );

    const me = await readMe();
    expect(me.report_access?.source).toBe('purchased');

    // Убираем покупку — виден следующий по приоритету источник.
    await ctx.db.query(`DELETE FROM entitlements WHERE user_id = $1`, [account.userId]);
    expect((await readMe()).report_access?.source).toBe('all_access');

    // Убираем «всё включено» — остаётся подаренный разбор.
    await ctx.db.query(`DELETE FROM grants WHERE user_id = $1 AND kind = 'all_access'`, [
      account.userId,
    ]);
    const last = await readMe();
    expect(last.report_access?.source).toBe('single_report');
    expect(last.report_access?.chart_id).toBeNull();
  });

  it('all_access без готового разбора: право есть, оплаченной карты нет', async () => {
    // Ровно тот случай, из-за которого round44 поднимал `full_report`:
    // проверяем, что право видно в `report_access`, а не в `full_report`.
    const account = await newAccount();
    await seedState('all_access действует', account);

    const me = await readMe();

    expect(me.report_access).toEqual({
      available: true,
      source: 'all_access',
      expires_at: expect.any(String),
      chart_id: null,
    });
    expect(me.entitlements.full_report).toBe(false);
    expect(me.entitlements.full_report_chart_id).toBeNull();

    // Обещание задачи 3: при `available: true` заказ не отвечает 402.
    const ordered = await request(ctx.app.getHttpServer())
      .post('/api/v1/reports')
      .set(INIT_DATA_HEADER, initDataFor())
      .set('Idempotency-Key', 'all-access-no-ready')
      .send({ chart_id: account.chartId, type: 'full' });

    expect(ordered.status).toBe(202);
    expect(ordered.body.report_id).toEqual(expect.any(String));
  });

  it('`chart_id: null` в заказе разбора — 422 и ни одной строки в счётах', async () => {
    const account = await newAccount();

    const before = await countBillingRows(account.userId);
    const response = await invoiceCall(null);
    const after = await countBillingRows(account.userId);

    expect(response.status).toBe(422);
    expect(response.body.details.reason).toBe('chart_required_for_report');
    expect(after).toEqual(before);
  });

  it('`/me` без карты не падает и не обещает разбор', async () => {
    // Человек может дойти до `/me` до онбординга: карты нет, `chart_id: null`.
    await request(ctx.app.getHttpServer())
      .get('/api/v1/me')
      .set(INIT_DATA_HEADER, initDataFor(445_100_999))
      .expect(200);

    const me = await request(ctx.app.getHttpServer())
      .get('/api/v1/me')
      .set(INIT_DATA_HEADER, initDataFor(445_100_999))
      .expect(200);

    const body = me.body as MeBody;
    expect(body.chart_id).toBeNull();
    expect(body.report_access).toEqual({
      available: false,
      source: null,
      expires_at: null,
      chart_id: null,
    });
  });

  it('без `chartId` (карты нет) право не выдумывает карту: `available: true`, `chart_id: null`', async () => {
    // Ветка «`/me` не передал карту»: `reportAccess(userId)` без `chartId`.
    // Через HTTP её не воспроизвести — `chart_id` в `/me` берётся из `charts`,
    // а `entitlements.chart_id` ссылается на ту же таблицу: покупка без карты
    // невозможна. Поэтому проверяется сама функция — та же, что стоит за `/me`.
    const account = await newAccount();
    await ctx.db.query(
      `INSERT INTO entitlements (user_id, kind, chart_id, status) VALUES ($1, 'report', $2, 'active')`,
      [account.userId, account.chartId],
    );

    const withoutChart = await access.reportAccess(account.userId);

    expect(withoutChart).toEqual({
      available: true,
      source: 'purchased',
      expiresAt: null,
      // Показывать здесь `account.chartId` значило бы обещать разбор не по той
      // карте, которую видит человек в `/me`.
      chartId: null,
    });

    // А с картой — та же покупка и тот же ответ, но уже с привязкой.
    const withChart = await access.reportAccess(account.userId, { chartId: account.chartId });
    expect(withChart.chartId).toBe(account.chartId);
  });

  it('забаненный человек: `available: false` и счёт не создаётся', async () => {
    const account = await newAccount();
    await seedState('all_access действует', account);
    // Бан — пара полей: `users_ban_consistent` требует причину (миграция 0040).
    await ctx.db.query(
      `UPDATE users SET banned_at = now(), ban_reason = 'qa: проверка матрицы' WHERE id = $1`,
      [account.userId],
    );

    const me = await readMe();
    expect(me.report_access).toEqual({
      available: false,
      source: null,
      expires_at: null,
      chart_id: null,
    });

    const before = await countBillingRows(account.userId);
    const response = await invoiceCall(account.chartId);
    const after = await countBillingRows(account.userId);

    expect(response.status).toBe(403);
    expect(after).toEqual(before);
  });
});
