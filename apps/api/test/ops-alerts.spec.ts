import { mkdtemp, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Response } from 'express';
import { INIT_DATA_HEADER } from '../src/modules/auth/init-data';
import type { AppEnv } from '../src/config/env';
import type { DbService } from '../src/db/db.service';
import { HealthController } from '../src/modules/health/health.controller';
import type { AdminMetricsService, ProductMetrics } from '../src/modules/ops/admin-metrics.service';
import { AlertsService, ALERT_THRESHOLDS, type AlertsResponse } from '../src/modules/ops/alerts.service';
import type { TelegramWebhookService, WebhookHealth } from '../src/modules/telegram/telegram-webhook.service';
import { createTestContext, truncateAll, type TestContext } from './test-app';
import { signInitData } from './init-data-fixture';
import { FICTIONAL_USER, TEST_BOT_TOKEN } from './test-env';

/**
 * `/health` и `/admin/alerts` для внешнего мониторинга (итерация 36).
 *
 * Проверяется то, что нельзя увидеть на скриншоте: тело и код ответа при
 * деградации, шесть правил на пороге и ниже порога, `since` как время первого
 * превышения, и то, что отсутствие маркера бэкапа — это срабатывание, а не
 * тишина.
 */

const HOUR_MS = 60 * 60 * 1000;

function metricsWith(overrides: Partial<ProductMetrics>): AdminMetricsService {
  const base = {
    pre_checkout_rejected_24h: 0,
    payment_failed_24h: 0,
    subscription_cancel_no_charge_id_24h: 0,
    forecast_cost_rub_24h: 0,
    questions_cost_rub_24h: 0,
    compat_cost_rub_24h: 0,
    compat_failed_24h: 0,
    forecast_failed_24h: 0,
    questions_failed_24h: 0,
    pdf_failed_24h: 0,
    ...overrides,
  };

  return { getMetrics: () => Promise.resolve(base as ProductMetrics) } as unknown as AdminMetricsService;
}

function webhookWith(health: WebhookHealth): TelegramWebhookService {
  return { health: () => health } as unknown as TelegramWebhookService;
}

function crossingsWith(values: {
  payment?: string | null;
  cancel?: string | null;
  spend?: string | null;
  failures?: string | null;
}): DbService {
  return {
    queryOne: () =>
      Promise.resolve({
        payment: values.payment === undefined || values.payment === null ? null : new Date(values.payment),
        cancel: values.cancel === undefined || values.cancel === null ? null : new Date(values.cancel),
        spend: values.spend === undefined || values.spend === null ? null : new Date(values.spend),
        failures:
          values.failures === undefined || values.failures === null ? null : new Date(values.failures),
      }),
  } as unknown as DbService;
}

const NO_MARKER = 'no-marker';

async function alertsWith(options: {
  metrics?: Partial<ProductMetrics>;
  webhook?: WebhookHealth;
  crossings?: Parameters<typeof crossingsWith>[0];
  backupFile?: string;
  env?: Partial<AppEnv>;
}): Promise<AlertsResponse> {
  const env = {
    BACKUP_STATE_FILE: options.backupFile,
    ...options.env,
  } as unknown as AppEnv;

  const service = new AlertsService(
    metricsWith(options.metrics ?? {}),
    webhookWith(options.webhook ?? { state: 'ok', ok: true, checkedAt: new Date().toISOString() }),
    crossingsWith(options.crossings ?? {}),
    env,
  );

  return service.list();
}

const alertById = (response: AlertsResponse, id: string) => {
  const alert = response.alerts.find((entry) => entry.id === id);
  if (alert === undefined) throw new Error(`в ответе нет алерта ${id}`);
  return alert;
};

describe('алерты: правила', () => {
  // «Сейчас» — реальные часы процесса: сервис считает возраст вебхука и
  // маркера от `new Date()`, и подменять их в тесте значило бы проверять
  // арифметику, а не поведение.
  const NOW = new Date();

  it('оплата: один отказ — срабатывание, ноль — тишина', async () => {
    const fired = await alertsWith({ metrics: { payment_failed_24h: 1 } });
    expect(alertById(fired, 'payment_not_arriving')).toMatchObject({
      level: 'critical',
      value: 1,
      threshold: 0,
      fired: true,
    });

    const quiet = await alertsWith({});
    expect(alertById(quiet, 'payment_not_arriving')).toMatchObject({ value: 0, fired: false, since: null });
  });

  it('вебхук: не в порядке дольше 10 минут — срабатывание, 5 минут — нет', async () => {
    const long = await alertsWith({
      webhook: { state: 'unreachable', ok: false, checkedAt: new Date(NOW.getTime() - 11 * 60_000).toISOString() },
    });
    const longAlert = alertById(long, 'telegram_webhook');
    expect(longAlert).toMatchObject({ level: 'critical', value: 11, threshold: 10, fired: true });
    expect(longAlert.since).toBe(new Date(NOW.getTime() - 11 * 60_000).toISOString());

    const brokenAt = new Date(NOW.getTime() - 5 * 60_000).toISOString();
    const short = await alertsWith({ webhook: { state: 'unreachable', ok: false, checkedAt: brokenAt } });
    // Порог не превышен, но `since` уже заполнен: это момент поломки, и по нему
    // видно, сколько осталось до срабатывания.
    expect(alertById(short, 'telegram_webhook')).toMatchObject({ value: 5, fired: false, since: brokenAt });

    // `stale` без единой проверки: значение неизвестно, и это не «всё хорошо».
    const never = await alertsWith({ webhook: { state: 'stale', ok: false, checkedAt: null } });
    expect(alertById(never, 'telegram_webhook')).toMatchObject({ value: null, fired: true });
  });

  it('отмена подписки: `no_charge_id` — срабатывание', async () => {
    const fired = await alertsWith({ metrics: { subscription_cancel_no_charge_id_24h: 1 } });
    expect(alertById(fired, 'subscription_cancel_blocked')).toMatchObject({
      level: 'critical',
      value: 1,
      fired: true,
    });
  });

  it('расход LLM: 510 ₽ — срабатывание, ровно 500 — нет (порог строгий)', async () => {
    const above = await alertsWith({
      metrics: { forecast_cost_rub_24h: 300, questions_cost_rub_24h: 150, compat_cost_rub_24h: 60 },
    });
    expect(alertById(above, 'llm_spend')).toMatchObject({ level: 'warning', value: 510, fired: true });

    const exact = await alertsWith({
      metrics: { forecast_cost_rub_24h: 400, questions_cost_rub_24h: 100, compat_cost_rub_24h: 0 },
    });
    expect(alertById(exact, 'llm_spend')).toMatchObject({ value: 500, fired: false });
  });

  it('провалы генераций: шесть — срабатывание, пять — нет', async () => {
    const above = await alertsWith({
      metrics: { compat_failed_24h: 2, forecast_failed_24h: 2, questions_failed_24h: 1, pdf_failed_24h: 1 },
    });
    expect(alertById(above, 'generations_failing')).toMatchObject({ level: 'warning', value: 6, fired: true });

    const exact = await alertsWith({
      metrics: { compat_failed_24h: 1, forecast_failed_24h: 1, questions_failed_24h: 1, pdf_failed_24h: 2 },
    });
    expect(alertById(exact, 'generations_failing')).toMatchObject({ value: 5, fired: false });
  });

  it('`since` — время первого превышения порога, а не начала окна', async () => {
    const first = '2026-11-20T11:00:00.000Z';
    const response = await alertsWith({
      metrics: { payment_failed_24h: 2 },
      crossings: { payment: first, failures: '2026-11-20T10:00:00.000Z' },
    });

    expect(alertById(response, 'payment_not_arriving').since).toBe(first);
  });
});

describe('алерты: пороги в одном месте', () => {
  it('значения порогов совпадают с описанием контракта', () => {
    expect(ALERT_THRESHOLDS).toEqual({
      payment_not_arriving: 0,
      telegram_webhook: 10,
      subscription_cancel_blocked: 0,
      llm_spend: 500,
      generations_failing: 5,
      backup_stale: 36,
      // Седьмое правило (1.6.13): провалы утреннего пуша за сутки.
      push_failed: 20,
    });
  });
});

describe('алерты: бэкап', () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'astro-backup-alert-'));
  });

  async function markerAgedHours(hours: number): Promise<string> {
    const file = join(dir, `marker-${String(hours)}`);
    await writeFile(file, 'ok\n');
    const at = new Date(Date.now() - hours * HOUR_MS);
    await utimes(file, at, at);
    return file;
  }

  it('маркер старше 36 часов — срабатывание, `since` = момент пересечения порога', async () => {
    const file = await markerAgedHours(40);
    const response = await alertsWith({ backupFile: file });
    const alert = alertById(response, 'backup_stale');

    expect(alert).toMatchObject({ level: 'warning', threshold: 36, fired: true });
    expect(alert.value).toBeGreaterThan(39);
    expect(alert.value).toBeLessThan(41);
    // Порог пересечён 4 часа назад, а не «сейчас».
    const since = new Date(alert.since ?? '').getTime();
    const expected = Date.now() - 4 * HOUR_MS;
    expect(Math.abs(since - expected)).toBeLessThan(2 * 60_000);
  });

  it('свежий маркер — тишина', async () => {
    const file = await markerAgedHours(10);
    const response = await alertsWith({ backupFile: file });

    expect(alertById(response, 'backup_stale')).toMatchObject({ threshold: 36, fired: false, since: null });
  });

  it('маркера нет или путь не настроен — срабатывание: молчание не равно «всё хорошо»', async () => {
    const missing = await alertsWith({ backupFile: join(dir, 'нет-такого-файла') });
    expect(alertById(missing, 'backup_stale')).toMatchObject({ value: null, fired: true });

    const notConfigured = await alertsWith({ backupFile: undefined });
    expect(alertById(notConfigured, 'backup_stale')).toMatchObject({ value: null, fired: true });
  });

  it('путь-заглушка не считается маркером', async () => {
    const response = await alertsWith({ backupFile: NO_MARKER });
    expect(alertById(response, 'backup_stale').fired).toBe(true);
  });
});

describe('GET /admin/alerts и /health — маршруты', () => {
  let ctx: TestContext;
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'astro-alerts-route-'));
    ctx = await createTestContext({
      env: {
        ADMIN_TG_ID: String(FICTIONAL_USER.id),
        // Маркера бэкапа в тестах нет: алерт должен быть виден снаружи.
        BACKUP_STATE_FILE: join(dir, 'backup-last-success'),
        MINI_APP_URL: 'http://localhost:8080',
      },
    });
  });

  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(async () => {
    await truncateAll(ctx.db);
  });

  function initDataFor(id: number): string {
    return signInitData({ botToken: TEST_BOT_TOKEN, user: { ...FICTIONAL_USER, id } });
  }

  it('отдаёт все семь алертов с уровнями и порогами', async () => {
    const response = await request(ctx.app.getHttpServer())
      .get('/api/v1/admin/alerts')
      .set(INIT_DATA_HEADER, initDataFor(FICTIONAL_USER.id))
      .expect(200);

    const body = response.body as AlertsResponse;
    expect(body.alerts.map((alert) => alert.id)).toEqual([
      'payment_not_arriving',
      'telegram_webhook',
      'subscription_cancel_blocked',
      'llm_spend',
      'generations_failing',
      'push_failed',
      'backup_stale',
    ]);
    expect(body.checked_at).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
    expect(body.alerts.map((alert) => alert.level)).toEqual([
      'critical',
      'critical',
      'critical',
      'warning',
      'warning',
      'warning',
      'warning',
    ]);
    // Метрики пустые, но два алерта всё равно сработали, и это правда:
    // вебхук ни разу не проверяли (stale — не «ok»), а маркера бэкапа нет.
    const fired = body.alerts.filter((alert) => alert.fired).map((alert) => alert.id);
    expect(fired).toEqual(['telegram_webhook', 'backup_stale']);
  });

  it('чужому — 403, как у метрик', async () => {
    await request(ctx.app.getHttpServer())
      .get('/api/v1/admin/alerts')
      .set(INIT_DATA_HEADER, initDataFor(FICTIONAL_USER.id + 1))
      .expect(403);
  });

  it('/health отдаёт флаги и время проверки, код 200 при degraded', async () => {
    const response = await request(ctx.app.getHttpServer()).get('/api/v1/health').expect(200);

    expect(response.body).toMatchObject({
      status: 'degraded',
      telegram_webhook: 'stale',
      flags: { test_plans: false, report_breaker: true },
    });
    expect(typeof response.body.checked_at).toBe('string');
  });
});

describe('/health — коды ответа', () => {
  function controllerWith(dbOk: boolean): HealthController {
    const db = { ping: () => Promise.resolve(dbOk) } as unknown as DbService;
    const astro = { health: () => Promise.resolve('ok') } as never;
    const env = {
      APPLICATION_VERSION: '0.0.0-test',
      PAYMENTS_TEST_PLANS: undefined,
      REPORT_BREAKER_ENABLED: '1',
    } as unknown as AppEnv;
    const webhook = webhookWith({ state: 'ok', ok: true, checkedAt: new Date().toISOString() });

    return new HealthController(db, astro, env, webhook);
  }

  function fakeResponse(): { status: (code: number) => void; code: number } {
    const state = {
      code: 200,
      status(code: number) {
        state.code = code;
      },
    };
    return state;
  }

  it('всё в порядке → 200 и status: ok', async () => {
    const response = fakeResponse();
    const body = await controllerWith(true).health(response as unknown as Response);

    expect(body.status).toBe('ok');
    expect(response.code).toBe(200);
  });

  it('БД недоступна → 503, тело той же формы', async () => {
    const response = fakeResponse();
    const body = await controllerWith(false).health(response as unknown as Response);

    expect(response.code).toBe(503);
    expect(body).toMatchObject({ status: 'degraded', db: 'down' });
  });
});
