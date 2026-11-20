import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Me } from '@astro-soul/shared';
import { INIT_DATA_HEADER } from '../src/modules/auth/init-data';
import { userIdFromTelegramId } from '../src/modules/users/pseudonym';
import { TelegramInlineService } from '../src/modules/telegram/telegram-inline.service';
import { createTestContext, truncateAll, type TestContext } from './test-app';
import { signInitData } from './init-data-fixture';
import { makeFakeAstro } from './fake-astro';
import { makeFakeTelegram, type FakeTelegram } from './fake-telegram';
import { FICTIONAL_USER, TEST_BOT_TOKEN, TEST_PEPPER } from './test-env';

/**
 * `Me.share` — возможность шаринга в `GET /me` (контракт 1.6.10).
 *
 * Зачем поле. `share_url` приходит только в ответе `POST /share/card`, поэтому
 * клиент узнавал, что ссылки нет, **создав карточку**: первый тап «Поделиться»
 * ничего не открывал, кнопка исчезала. Плюс `getMe().supports_inline_queries`
 * сервер знает, но клиенту не отдавал, и клиент гадал по наличию метода в SDK.
 *
 * Проверяется то, что нельзя увидеть глазами: оба состояния `link`, все три
 * состояния `inline`, согласованность `link` и `ShareCard.share_url`, и то, что
 * новое поле ничего не сдвинуло в остальных частях `Me`.
 */

function initData(): string {
  return signInitData({ botToken: TEST_BOT_TOKEN, user: FICTIONAL_USER });
}

interface ShareFields {
  readonly link?: boolean;
  readonly inline?: 'on' | 'off' | 'unknown';
}

async function shareOf(ctx: TestContext): Promise<ShareFields> {
  const response = await request(ctx.app.getHttpServer())
    .get('/api/v1/me')
    .set(INIT_DATA_HEADER, initData())
    .expect(200);

  const body = response.body as Me;
  expect(body.share).toBeDefined();
  return body.share as ShareFields;
}

/** Карта, из которой собирается карточка дня: без неё `POST /share/card` — 403. */
async function withChart(ctx: TestContext): Promise<void> {
  const userId = userIdFromTelegramId(BigInt(FICTIONAL_USER.id), TEST_PEPPER);

  // Пользователь появляется тем же путём, что в проде: на `GET /me`.
  await request(ctx.app.getHttpServer())
    .get('/api/v1/me')
    .set(INIT_DATA_HEADER, initData())
    .expect(200);

  await ctx.db.query(
    `INSERT INTO charts (user_id, input_hash, data, engine_version, time_known)
     VALUES ($1, 'share-hash', $2::jsonb, '1.0.0', true)`,
    [userId, JSON.stringify(CHART_DATA)],
  );
}

const CHART_DATA = {
  chart: {
    birth: {
      date: '1994-05-17',
      time: '14:20',
      place: {
        name: 'Тестоград',
        country: 'RU',
        lat: 55.7558,
        lon: 37.6173,
        tz: 'Europe/Moscow',
      },
    },
  },
} as const;

describe('Me.share — имя бота настроено', () => {
  let ctx: TestContext;
  let telegram: FakeTelegram;
  let inline: TelegramInlineService;

  beforeAll(async () => {
    telegram = makeFakeTelegram();
    ctx = await createTestContext({
      astro: makeFakeAstro(),
      telegram,
      // `BOT_USERNAME` уже задан тестовым окружением (`astro_soul_test_bot`);
      // здесь важна именно настроенная ветка.
      env: { BOT_USERNAME: 'astro_soul_test_bot', PUBLIC_API_URL: 'https://api.test' },
    });
    inline = ctx.app.get(TelegramInlineService);
  });

  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(async () => {
    await truncateAll(ctx.db);
    telegram.inlineMode = true;
    telegram.getMeError = false;
  });

  it('`link: true` — ссылка в бота будет', async () => {
    const share = await shareOf(ctx);

    expect(share.link).toBe(true);
    // Значение `inline` зависит от того, вызывали ли `checkMode` раньше в этом
    // процессе, поэтому здесь проверяется только принадлежность контракту;
    // «до проверки — unknown» проверяется на свежем приложении ниже.
    expect(['on', 'off', 'unknown']).toContain(share.inline);
  });

  it('`inline` отражает результат `checkMode`: on и off', async () => {
    telegram.inlineMode = true;
    await expect(inline.checkMode()).resolves.toBe('on');
    expect((await shareOf(ctx)).inline).toBe('on');

    telegram.inlineMode = false;
    await expect(inline.checkMode()).resolves.toBe('off');
    expect((await shareOf(ctx)).inline).toBe('off');
  });

  it('недоступный Bot API не стирает последнее известное состояние', async () => {
    telegram.inlineMode = false;
    await inline.checkMode();

    telegram.getMeError = true;
    // Проверка честно говорит «не знаю»…
    await expect(inline.checkMode()).resolves.toBe('unknown');
    // …но клиенту отдаётся последнее известное, а не «выключено» вместо него.
    expect((await shareOf(ctx)).inline).toBe('off');
  });

  it('`link: true` согласован со `ShareCard.share_url`', async () => {
    await withChart(ctx);

    const response = await request(ctx.app.getHttpServer())
      .post('/api/v1/share/card')
      .set(INIT_DATA_HEADER, initData())
      .send({ kind: 'day' })
      .expect(200);

    // Один и тот же признак: имя бота есть — ссылка есть.
    expect((response.body as { share_url: string | null }).share_url).toMatch(
      /^https:\/\/t\.me\/astro_soul_test_bot\?start=sh_/u,
    );
  });

  it('новое поле не сдвинуло остальные части `Me`', async () => {
    const response = await request(ctx.app.getHttpServer())
      .get('/api/v1/me')
      .set(INIT_DATA_HEADER, initData())
      .expect(200);

    const body = response.body as Me;
    // Поля, по которым клиент рисует стартовый экран: все на месте.
    expect(body.entitlements).toBeDefined();
    expect(Array.isArray(body.quotas)).toBe(true);
    expect(body.onboarding_step).toBeDefined();
    expect(body.limits?.geo_min_query_length).toBeGreaterThan(0);
    expect(typeof body.has_profile).toBe('boolean');
    expect(typeof body.has_chart).toBe('boolean');
    expect(body.subscription).toBeDefined();
  });
});

describe('Me.share — имя бота не настроено', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    // Пустая строка в `BOT_USERNAME` — это «не задано» (`env.ts` приводит её к
    // undefined): ссылку собрать не из чего.
    ctx = await createTestContext({
      astro: makeFakeAstro(),
      telegram: makeFakeTelegram(),
      env: { BOT_USERNAME: '', PUBLIC_API_URL: 'https://api.test' },
    });
  });

  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(async () => {
    await truncateAll(ctx.db);
  });

  it('`link: false` — клиент не рисует кнопку шаринга', async () => {
    const share = await shareOf(ctx);

    expect(share.link).toBe(false);
    // Проверки не было (`checkMode` в этом процессе не вызывался) — `unknown`,
    // а не «выключено»: `/setinline` мог включить режим уже после старта API.
    expect(share.inline).toBe('unknown');
  });

  it('`link: false` значит и `share_url: null` в `POST /share/card`', async () => {
    await withChart(ctx);

    const response = await request(ctx.app.getHttpServer())
      .post('/api/v1/share/card')
      .set(INIT_DATA_HEADER, initData())
      .send({ kind: 'day' })
      .expect(200);

    const body = response.body as { share_url: string | null; url: string };
    expect(body.share_url).toBeNull();
    // Файл при этом отдаётся: карточка собрана, отправлять её некуда.
    expect(body.url).toContain('sig=');
  });

  it('остальные части `Me` не изменились', async () => {
    const response = await request(ctx.app.getHttpServer())
      .get('/api/v1/me')
      .set(INIT_DATA_HEADER, initData())
      .expect(200);

    const body = response.body as Me;
    expect(body.is_new).toBe(true);
    expect(body.has_profile).toBe(false);
    expect(body.entitlements.is_active).toBe(false);
  });
});
