// @vitest-environment node
/*
 * The dev mock stands in for the server (`API_MOCK=1`). Checked here is what would
 * otherwise break it without a word: the consent version it accepts, its answer to a
 * batch of events, and the PNG it writes out byte by byte.
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { crc32, inflateSync } from 'node:zlib';
import type { Connect } from 'vite';
import { describe, expect, it } from 'vitest';
import { askOutcome, buildForecast, FORECAST_SCENARIOS, localDay } from '../mock/engagement.ts';
import { MOCK_CONSENT_VERSION, RETURNING_INPUT } from '../mock/fixtures.ts';
import { eventsAnswer, mockApi } from '../mock/plugin.ts';
import { renderMockWheelPng } from '../mock/wheelPng.ts';
import { CONSENT_VERSION } from '../src/i18n/ru.ts';

describe('mock API', () => {
  it('accepts the version of the app\'s own texts: after a new CONSENT_VERSION the mock needs the same date', () => {
    expect(MOCK_CONSENT_VERSION).toBe(CONSENT_VERSION);
  });

  it('answers a batch of events the way the contract says: takes, refuses whole, or drops in silence', () => {
    const NOW = Date.parse('2026-11-10T12:00:00.000Z');
    const occurred_at = new Date(NOW).toISOString();
    const answer = (events: unknown) => eventsAnswer({ events }, NOW);

    expect(answer([{ name: 'app_open', occurred_at }, { name: 'screen_view', occurred_at, props: { step: 'welcome' } }])).toEqual({ accepted: 2 });
    // One event the contract does not have: the whole batch is refused.
    expect(answer([{ name: 'app_open', occurred_at }, { name: 'app_closed', occurred_at }])).toEqual({
      errors: [{ field: 'events.name', message: expect.any(String) as string }],
    });
    // The time under its old name, `at`: not the contract's field any more.
    expect(answer([{ name: 'app_open', at: occurred_at }])).toEqual({
      errors: [{ field: 'events.occurred_at', message: expect.any(String) as string }],
    });
    expect(answer([])).toHaveProperty('errors');
    // Props named like personal data: the event is dropped, the batch is not an error.
    expect(answer([{ name: 'app_open', occurred_at }, { name: 'place_search', occurred_at, props: { query: 'x' } }])).toEqual({ accepted: 1 });
  });

  it('writes a PNG a viewer can open: signature, intact chunks, as many pixels as the header says', () => {
    const png = renderMockWheelPng('dark', 200);
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

    const chunks: { type: string; data: Buffer; intact: boolean }[] = [];
    for (let offset = 8; offset < png.length; ) {
      const length = png.readUInt32BE(offset);
      const body = png.subarray(offset + 4, offset + 8 + length);
      chunks.push({ type: body.subarray(0, 4).toString('ascii'), data: body.subarray(4), intact: png.readUInt32BE(offset + 8 + length) === crc32(body) });
      offset += 12 + length;
    }
    expect(chunks.map(({ type }) => type)).toEqual(['IHDR', 'PLTE', 'IDAT', 'IEND']);
    expect(chunks.every(({ intact }) => intact)).toBe(true);

    const [header, , data] = chunks;
    expect([header?.data.readUInt32BE(0), header?.data.readUInt32BE(4)]).toEqual([200, 200]);
    // A filter byte and 200 palette indexes per row; more than one colour, so not a blank square.
    const pixels = inflateSync(data?.data ?? Buffer.alloc(0));
    expect(pixels.length).toBe(201 * 200);
    expect(new Set(pixels).size).toBeGreaterThan(2);
  });
});

describe('mock API: the forecast and the questions, by the rules of apps/api', () => {
  const CHART = '00000000-0000-4000-8000-00000000c0de';
  const BASIS = ['Солнце в Тельце', 'Луна в Раке'];
  const some = { used: 2, limit: 5 };
  const none = { used: 5, limit: 5 };
  const ask = (question: unknown, quota = some, chartId: unknown = CHART) => askOutcome({ chart_id: chartId, question }, quota, BASIS);

  describe('the day of a zone', () => {
    // 22:30 UTC on 10 November: the 11th in Moscow (01:30), still the 10th in Amsterdam (23:30).
    const evening = Date.parse('2026-11-10T22:30:00.000Z');

    it('is the calendar day where the zone is, and ends at the midnight there', () => {
      expect(localDay('Europe/Moscow', evening)).toEqual({ date: '2026-11-11', endsAt: Date.parse('2026-11-11T21:00:00.000Z') });
      expect(localDay('Europe/Amsterdam', evening)).toEqual({ date: '2026-11-10', endsAt: Date.parse('2026-11-10T23:00:00.000Z') });
      expect(localDay('UTC', evening)).toEqual({ date: '2026-11-10', endsAt: Date.parse('2026-11-11T00:00:00.000Z') });
    });

    it('starts a new day exactly at that midnight', () => {
      const midnight = Date.parse('2026-11-10T21:00:00.000Z');
      expect(localDay('Europe/Moscow', midnight - 1).date).toBe('2026-11-10');
      expect(localDay('Europe/Moscow', midnight - 1).endsAt).toBe(midnight);
      expect(localDay('Europe/Moscow', midnight).date).toBe('2026-11-11');
    });
  });

  describe('a forecast', () => {
    const now = Date.parse('2026-11-10T09:00:00.000Z');

    it('without a subscription is the short text with no focus; with one, the full text with a focus the app has a word for', () => {
      const short = buildForecast('2026-11-10', false, now);
      const full = buildForecast('2026-11-10', true, now);

      expect(short).toMatchObject({ date: '2026-11-10', focus: null, is_paid: false });
      expect(full).toMatchObject({ date: '2026-11-10', is_paid: true });
      expect(['career', 'love', 'money', 'health', 'self']).toContain(full.focus);
      expect(full.text.length).toBeGreaterThan(short.text.length);
      // The mock says of itself that it is one: nobody takes its text for a reading of their chart.
      expect(short.text).toMatch(/мок/i);
      expect(full.text).toMatch(/мок/i);
    });

    it('shows every focus over five days in a row', () => {
      const days = ['2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13', '2026-11-14'];
      expect(new Set(days.map((day) => buildForecast(day, true, now).focus)).size).toBe(5);
    });

    it('`stale` is dated the day before, over a month\'s edge as well', () => {
      expect(buildForecast('2026-11-10', true, now, true).date).toBe('2026-11-09');
      expect(buildForecast('2026-12-01', false, now, true).date).toBe('2026-11-30');
    });

    it('has the five scenarios the README names', () => {
      expect([...FORECAST_SCENARIOS]).toEqual(['auto', 'ready', 'pending', 'stale', '500']);
    });
  });

  describe('a question', () => {
    it('is answered and counted, with what the answer rests on', () => {
      expect(ask('На что опереться в работе?')).toEqual({
        kind: 'answer',
        chartId: CHART,
        body: { answer: expect.stringMatching(/мок/i) as string, based_on: BASIS },
        counted: true,
      });
    });

    it.each([
      ['two characters', 'Да'],
      ['spaces around two characters', '   Да   '],
      ['501 characters', 'я'.repeat(501)],
      ['not a text', 42],
      ['nothing', undefined],
    ])('of %s is refused with the server\'s words about the field', (_name, question) => {
      expect(ask(question)).toEqual({ kind: 'invalid', errors: [{ field: 'question', message: 'Вопрос — от 3 до 500 знаков' }] });
    });

    it.each([
      ['three characters', 'Да?'],
      ['500 characters', 'я'.repeat(500)],
      ['500 characters and spaces around them', `  ${'я'.repeat(500)}  `],
    ])('of %s is within the limits: the length is counted after trimming', (_name, question) => {
      expect(ask(question).kind).toBe('answer');
    });

    it('names the chart as well when that is not an id', () => {
      expect(ask('Вопрос?', some, 'not-a-uuid')).toEqual({ kind: 'invalid', errors: [{ field: 'chart_id', message: expect.any(String) as string }] });
      expect(ask('Да', some, null)).toMatchObject({ kind: 'invalid', errors: [{ field: 'chart_id' }, { field: 'question' }] });
    });

    it.each([
      ['health', 'Какой у меня диагноз?', 'к врачу'],
      ['death', 'Когда я умру?', 'к врачу'],
      ['money guarantees', 'Стоит ли вложиться в крипту?', 'гарантии дохода'],
      ['law', 'Подавать ли иск в суд?', 'к юристу'],
    ])('about %s gets a soft refusal as an answer: 200, nothing it rests on, and not counted', (_name, question, where) => {
      const outcome = ask(question);
      expect(outcome).toMatchObject({ kind: 'answer', counted: false, body: { based_on: [] } });
      expect(outcome.kind === 'answer' && outcome.body.answer).toMatch(/^Про это я не могу: /);
      expect(outcome.kind === 'answer' && outcome.body.answer).toContain(where);
    });

    it('takes «судьба» for an ordinary question, as apps/api does: the word for a court is not in it', () => {
      expect(ask('Что карта говорит про мою судьбу?')).toMatchObject({ kind: 'answer', counted: true });
    });

    it('is checked in the order of apps/api: the body, then the topic, then the quota', () => {
      // With nothing left: a bad body is still a 422, and a refusal on a topic is still an answer.
      expect(ask('Да', none).kind).toBe('invalid');
      expect(ask('Какой у меня диагноз?', none)).toMatchObject({ kind: 'answer', counted: false });
      expect(ask('На что опереться в работе?', none)).toEqual({ kind: 'exhausted', chartId: CHART });
    });

    it('has no limit to run into with a limit of -1', () => {
      expect(ask('На что опереться в работе?', { used: 100, limit: -1 }).kind).toBe('answer');
    });

    it.each([
      ['ошибка', 'error'],
      ['Лимит', 'cap'],
    ])('starting with «%s» asks for a failure worth seeing (%s), whatever the quota', (word, scenario) => {
      expect(ask(`${word} и что будет?`, none)).toEqual({ kind: 'scenario', chartId: CHART, scenario });
    });

    it('«оплата…» is an ordinary question: apps/api answers no question with a 402, and the mock plays none', () => {
      expect(ask('оплата и что будет?', some)).toMatchObject({ kind: 'answer', counted: true });
    });
  });
});

/**
 * The mock as the dev server runs it: the plugin's middleware behind a real HTTP server,
 * asked over HTTP the way the app asks. What the mock remembers between two requests is
 * seen only this way.
 */
async function serveMock(me: string) {
  const handlers: Connect.NextHandleFunction[] = [];
  const { configureServer } = mockApi({ delayMs: 0, me });
  if (typeof configureServer !== 'function') throw new Error('the mock is expected to hook into the dev server with a function');
  // All the plugin asks of a dev server is a place for its middleware.
  const devServer = {
    middlewares: {
      use(handler: Connect.NextHandleFunction) {
        handlers.push(handler);
      },
    },
  };
  await (configureServer as unknown as (server: typeof devServer) => unknown)(devServer);
  const [middleware] = handlers;
  if (middleware === undefined) throw new Error('the mock registered no middleware');

  const server = createServer((req, res) => {
    middleware(req, res, () => {
      res.statusCode = 404;
      res.end();
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;

  return {
    async request(method: string, path: string, body?: unknown) {
      const response = await fetch(`http://127.0.0.1:${String(port)}/api/v1${path}`, {
        method,
        headers: { 'X-Telegram-Init-Data': 'mock-init-data', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await response.text();
      return { status: response.status, body: text === '' ? undefined : (JSON.parse(text) as unknown) };
    },
    close() {
      return new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
        // The connections `fetch` keeps open would hold the server for seconds.
        server.closeAllConnections();
      });
    },
  };
}

describe('mock API: deleting the data, as contract 1.5.5 has it', () => {
  it('takes the subscription, the purchase and the chart with the data: whoever asks next is a new user', async () => {
    const mock = await serveMock('subscriber,paid');
    try {
      const before = (await mock.request('GET', '/me')).body as { chart_id: string };
      expect(before).toMatchObject({
        has_chart: true,
        subscription: { plan: 'month', is_active: true },
        entitlements: { is_active: true, full_forecast: true, full_report: true, full_report_chart_id: before.chart_id },
      });

      expect((await mock.request('DELETE', '/me')).status).toBe(204);

      // Not «the subscription lives on to the end of its period», as before 1.5.5: nothing bought outlives the data.
      expect((await mock.request('GET', '/me')).body).toMatchObject({
        is_new: true,
        has_chart: false,
        chart_id: null,
        latest_report_id: null,
        subscription: { plan: 'none', is_active: false, expires_at: null, auto_renew: false },
        // The chart of the purchase is named as null, not left out: the server sends the field every time.
        entitlements: { is_active: false, plan: 'none', full_forecast: false, full_report: false, full_report_chart_id: null, ask_per_day: 1 },
      });
    } finally {
      await mock.close();
    }
  });

  it('the forecast of the night goes with the chart: the same birth data entered again are a new chart, with none yet', async () => {
    const mock = await serveMock('subscriber');
    try {
      const { chart_id: chartId } = (await mock.request('GET', '/me')).body as { chart_id: string };
      const forecast = `/engagement/forecast?chart_id=${chartId}`;
      expect(await mock.request('GET', forecast)).toMatchObject({ status: 200, body: { is_paid: true } });

      await mock.request('DELETE', '/me');
      expect((await mock.request('GET', forecast)).status).toBe(404);

      const rebuilt = await mock.request('POST', '/charts', RETURNING_INPUT);
      // 201, not the 200 of a chart that was already there: the old one is gone.
      expect(rebuilt.status).toBe(201);
      const { chart_id: rebuiltId } = (rebuilt.body as { chart: { chart_id: string } }).chart;
      // Neither the full forecast of the subscriber who is gone nor a short one: the first night is still ahead.
      expect((await mock.request('GET', `/engagement/forecast?chart_id=${rebuiltId}`)).status).toBe(404);
    } finally {
      await mock.close();
    }
  });

  it('an invoice made before the deletion is void after it: a payment that arrives late buys nothing', async () => {
    const mock = await serveMock('returning');
    const subscribed = async () => ((await mock.request('GET', '/me')).body as { subscription: { is_active: boolean } }).subscription.is_active;
    /** What Telegram's webhook does on the real server. The mock applies it on a timer, so the answer is asked for after a pause. */
    const pay = async (link: string) => {
      expect((await mock.request('POST', '/__mock/payments', { invoice_link: link })).status).toBe(204);
      await new Promise((resolve) => setTimeout(resolve, 25));
    };
    try {
      const invoice = await mock.request('POST', '/billing/invoice', { plan_code: 'month_399' });
      expect(invoice.status).toBe(201);
      const { invoice_link: link } = invoice.body as { invoice_link: string };

      // The payment itself works: without a deletion in between it is a subscription.
      await pay(link);
      expect(await subscribed()).toBe(true);

      await mock.request('DELETE', '/me');
      expect(await subscribed()).toBe(false);
      await pay(link);
      expect(await subscribed()).toBe(false);
    } finally {
      await mock.close();
    }
  });
});

describe('mock API: the chart a report is bought for (`Entitlements.full_report_chart_id`, contract 1.5.4)', () => {
  const entitlementsOf = async (mock: Awaited<ReturnType<typeof serveMock>>) =>
    ((await mock.request('GET', '/me')).body as { entitlements: Record<string, unknown> }).entitlements;

  it('is in every answer, as apps/api sends it: null while nothing is bought, never left out', async () => {
    const mock = await serveMock('returning');
    try {
      const entitlements = await entitlementsOf(mock);
      expect(Object.keys(entitlements)).toContain('full_report_chart_id');
      expect(entitlements).toMatchObject({ full_report: false, full_report_chart_id: null });
    } finally {
      await mock.close();
    }
  });

  it('names the chart once its report is paid for, and no chart again once the purchase is taken back', async () => {
    const mock = await serveMock('returning');
    try {
      const { chart_id: chartId } = (await mock.request('GET', '/me')).body as { chart_id: string };
      const invoice = await mock.request('POST', '/billing/invoice', { plan_code: 'one_149', chart_id: chartId });
      expect(invoice.status).toBe(201);
      // An invoice alone buys nothing.
      expect(await entitlementsOf(mock)).toMatchObject({ full_report: false, full_report_chart_id: null });

      const { invoice_link: link } = invoice.body as { invoice_link: string };
      expect((await mock.request('POST', '/__mock/payments', { invoice_link: link })).status).toBe(204);
      // The mock applies a payment on a timer, as a webhook would arrive: the answer is asked for after a pause.
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(await entitlementsOf(mock)).toMatchObject({ full_report: true, full_report_chart_id: chartId });

      expect((await mock.request('POST', '/__mock/revoke')).status).toBe(204);
      expect(await entitlementsOf(mock)).toMatchObject({ full_report: false, full_report_chart_id: null });
    } finally {
      await mock.close();
    }
  });

  it('a subscription is not a report bought: it names no chart', async () => {
    const mock = await serveMock('subscriber');
    try {
      expect(await entitlementsOf(mock)).toMatchObject({ is_active: true, full_report: false, full_report_chart_id: null });
    } finally {
      await mock.close();
    }
  });
});
