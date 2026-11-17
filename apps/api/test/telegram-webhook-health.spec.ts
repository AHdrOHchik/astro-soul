import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createTestContext, type TestContext } from './test-app';
import { makeFakeAstro } from './fake-astro';
import { makeFakeTelegram } from './fake-telegram';
import { JsonLogger } from '../src/common/logger';
import { loadEnv, type AppEnv } from '../src/config/env';
import type { TelegramClient, WebhookInfo } from '../src/modules/telegram/telegram.client';
import {
  TELEGRAM_WEBHOOK_STALE_AFTER_MS,
  TelegramWebhookService,
} from '../src/modules/telegram/telegram-webhook.service';
import { hostFromUrl, resolveHost, webhookUnreachableHint } from '../src/modules/telegram/webhook-address';
import { AdminMetricsService } from '../src/modules/ops/admin-metrics.service';

/**
 * Итерация 26, задача 3: вебхук не должен «настроиться один раз и тихо умереть».
 *
 * Что проверяется:
 *   • адрес `MINI_APP_URL`, который не резолвится, останавливает регистрацию
 *     **до** Bot API: `setWebhook` на такой адрес Telegram принимает молча, а
 *     `pre_checkout_query` потом не приходит — то есть без этой проверки
 *     «оплата не проходит» выглядит как наша случайная ошибка;
 *   • WARN называет виновника и лечение: `MINI_APP_URL`, туннель, перезапуск;
 *   • состояние живёт не только в логе: `/health` отдаёт
 *     `telegram_webhook: ok|stale|unreachable`, `/admin/metrics` —
 *     `telegram_webhook_ok` и `telegram_webhook_checked_at`.
 */

const UNRESOLVABLE_HOST = 'webhook-does-not-exist.invalid';

type WebhookClient = Pick<TelegramClient, 'getWebhookInfo' | 'setWebhook'>;

function fakeClient(options: {
  url?: string;
  reachable?: boolean;
}): WebhookClient & { calls: string[] } {
  const calls: string[] = [];
  const info: WebhookInfo = {
    url: options.url ?? '',
    hasCustomCertificate: false,
    pendingUpdateCount: 0,
    lastErrorDate: null,
    lastErrorMessage: null,
    lastSynchronizationErrorDate: null,
    maxConnections: null,
    allowedUpdates: null,
  };

  return {
    calls,
    getWebhookInfo: () => {
      calls.push('getWebhookInfo');
      return Promise.resolve({
        ok: true,
        reachable: options.reachable ?? true,
        status: 200,
        description: null,
        result: info,
      });
    },
    setWebhook: () => {
      calls.push('setWebhook');
      return Promise.resolve({ ok: true, reachable: true, status: 200, description: null, result: true });
    },
  };
}

function serviceFor(
  client: WebhookClient,
  overrides: Partial<AppEnv> = {},
): TelegramWebhookService {
  // Окружение тестов реальное (setup-env): берём его и подменяем только то,
  // что нужно этому спек. `MINI_APP_URL: undefined` = переменной нет.
  const env: AppEnv = {
    ...loadEnv(),
    MINI_APP_URL: `https://${UNRESOLVABLE_HOST}`,
    TELEGRAM_WEBHOOK_SECRET: 'test-webhook-secret',
    ...overrides,
  };

  return new TelegramWebhookService(client as TelegramClient, env, new JsonLogger('error'));
}

describe('webhook-address — резолв до разговора с Bot API', () => {
  it('хост из URL и его отсутствие', () => {
    expect(hostFromUrl('https://astro-soul.example.com/api/v1/x')).toBe('astro-soul.example.com');
    expect(hostFromUrl('')).toBeNull();
    expect(hostFromUrl(null)).toBeNull();
  });

  it('нерезолвящийся адрес — это false с причиной, а не исключение', async () => {
    const resolution = await resolveHost(UNRESOLVABLE_HOST, 2000);

    expect(resolution.resolvable).toBe(false);
    expect(resolution.host).toBe(UNRESOLVABLE_HOST);
    expect(resolution.error).not.toBeNull();
  });

  it('IP-адрес считается резолвящимся: стенду DNS не нужен', async () => {
    const resolution = await resolveHost('127.0.0.1');
    expect(resolution).toMatchObject({ resolvable: true, addresses: ['127.0.0.1'] });
  });

  it('подсказка называет виновника, следствие и лечение', () => {
    const hint = webhookUnreachableHint({
      host: UNRESOLVABLE_HOST,
      resolvable: false,
      addresses: [],
      error: 'getaddrinfo ENOTFOUND',
    });

    expect(hint).toContain('MINI_APP_URL');
    expect(hint).toContain(UNRESOLVABLE_HOST);
    expect(hint).toContain('оплата в Telegram работать не будет');
    expect(hint).toContain('туннель');
    expect(hint).toContain('перезапусти API');
    expect(hint).toContain('payments:diagnose --set-webhook');
  });
});

describe('ensureRegistered — нерезолвящийся адрес', () => {
  it('Bot API не вызывается вовсе, состояние unreachable, в лог идёт подсказка', async () => {
    const client = fakeClient({});
    const service = serviceFor(client);

    const status = await service.ensureRegistered();

    expect(status.state).toBe('unreachable');
    expect(status.hint).toContain('MINI_APP_URL');
    // Главное: `setWebhook` не звали — иначе Telegram ответил бы «ок» на адрес,
    // до которого не дозвонится, и проблема стала бы невидимой.
    expect(client.calls).toEqual([]);
    expect(service.health()).toMatchObject({ state: 'unreachable', ok: false });
  });

  it('резолвящийся адрес проходит дальше, к getWebhookInfo', async () => {
    const client = fakeClient({});
    const service = serviceFor(client, { MINI_APP_URL: 'http://127.0.0.1:3000' });

    await service.ensureRegistered();

    expect(client.calls).toContain('getWebhookInfo');
  });

  it('совпадение адреса → ok и ok=true для метрик', async () => {
    const expected = `http://127.0.0.1:3000/api/v1/internal/telegram/webhook/test-webhook-secret`;
    const client = fakeClient({ url: expected });
    const service = serviceFor(client, { MINI_APP_URL: 'http://127.0.0.1:3000' });

    const status = await service.ensureRegistered();

    expect(status.state).toBe('ok');
    expect(service.health()).toMatchObject({ state: 'ok', ok: true });
  });

  it('автопочинка выключена и адрес не тот → stale, а не «всё хорошо»', async () => {
    const client = fakeClient({ url: 'https://old.example.com/api/v1/internal/telegram/webhook/old' });
    const service = serviceFor(client, {
      MINI_APP_URL: 'http://127.0.0.1:3000',
      TELEGRAM_WEBHOOK_AUTO: '0',
    });

    const status = await service.ensureRegistered();

    expect(status.state).toBe('mismatch');
    expect(service.health()).toMatchObject({ state: 'stale', ok: false });
  });

  it('свежесть: проверка старше суток — уже stale', async () => {
    const expected = 'http://127.0.0.1:3000/api/v1/internal/telegram/webhook/test-webhook-secret';
    const client = fakeClient({ url: expected });
    const service = serviceFor(client, { MINI_APP_URL: 'http://127.0.0.1:3000' });

    await service.ensureRegistered();
    expect(service.health().state).toBe('ok');

    // «Проверили вчера» — это не «работает сейчас»: туннель могли
    // перезапустить с новым адресом. Часы подменяем, сеть не трогаем.
    const realNow = Date.now();
    const spy = Date.now;
    Date.now = () => realNow + TELEGRAM_WEBHOOK_STALE_AFTER_MS + 1000;
    try {
      expect(service.health()).toMatchObject({ state: 'stale', ok: false });
    } finally {
      Date.now = spy;
    }
  });

  it('без секрета/адреса — not_configured и unreachable в /health', async () => {
    const service = serviceFor(fakeClient({}), { MINI_APP_URL: undefined });

    const status = await service.ensureRegistered();

    expect(status.state).toBe('not_configured');
    expect(service.health()).toMatchObject({ state: 'unreachable', ok: false });
  });
});

describe('/health и /admin/metrics видят состояние вебхука', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestContext({
      astro: makeFakeAstro(),
      telegram: makeFakeTelegram(),
      env: { MINI_APP_URL: `https://${UNRESOLVABLE_HOST}` },
    });
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('/health: до проверки — stale, после провала — unreachable', async () => {
    const before = await request(ctx.app.getHttpServer()).get('/api/v1/health').expect(200);
    expect(before.body.telegram_webhook).toBe('stale');

    const service = ctx.app.get(TelegramWebhookService);
    await service.ensureRegistered();

    const after = await request(ctx.app.getHttpServer()).get('/api/v1/health').expect(200);
    expect(after.body.telegram_webhook).toBe('unreachable');
    // Остальные поля не поменялись: добавлено поле, а не переписан ответ.
    expect(after.body).toMatchObject({ db: 'ok', llm: 'unknown' });
  });

  it('/admin/metrics: telegram_webhook_ok=false и время проверки заполнено', async () => {
    const metrics = await ctx.app.get(AdminMetricsService).getMetrics();

    expect(metrics.telegram_webhook_ok).toBe(false);
    expect(metrics.telegram_webhook_checked_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
