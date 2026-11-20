import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { FileStorageService } from '../src/modules/files/file-storage.service';
import { TelegramInlineService } from '../src/modules/telegram/telegram-inline.service';
import { parseInlineQueryShortId } from '../src/modules/charts/share-link';
import { createTestContext, truncateAll, type TestContext } from './test-app';
import { makeFakeAstro } from './fake-astro';
import { makeFakeTelegram, type FakeTelegram } from './fake-telegram';
import { TEST_WEBHOOK_SECRET } from './test-env';

/**
 * Inline-режим бота (контракт 1.6.9).
 *
 * Основной путь шаринга в мини-аппе — `switchInlineQuery`: человек жмёт
 * «Поделиться», Telegram открывает выбор чата, а карточку в него присылает бот.
 * Работает это только при двух условиях: у бота включён inline-режим в
 * BotFather (проверяется `checkMode` по `getMe`) и бэкенд отвечает на
 * `inline_query`. До 1.6.9 не было ни проверки, ни обработчика — кнопка молча
 * не делала ничего.
 *
 * Здесь проверяется то, что от нас зависит: ответ на запрос, свежая подпись в
 * картинке, пустой ответ на мусор и честное состояние режима.
 */

let ctx: TestContext;
let telegram: FakeTelegram;
let inline: TelegramInlineService;

beforeAll(async () => {
  telegram = makeFakeTelegram();
  ctx = await createTestContext({
    astro: makeFakeAstro(),
    telegram,
    env: { MINI_APP_URL: 'https://app.test', PUBLIC_API_URL: 'https://api.test' },
  });
  inline = ctx.app.get(TelegramInlineService);
});

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  await truncateAll(ctx.db);
  telegram.inlineAnswers.length = 0;
  telegram.inlineMode = true;
  telegram.getMeError = false;
});

/** Ровно 10 символов алфавита `shortIdOf`: без `0`, `1`, `o`, `l`. */
const SHORT_ID = 'k7m2p9x4qz';

async function cardFixture(): Promise<void> {
  await ctx.db.query(
    `INSERT INTO share_cards (kind, content_hash, short_id, storage_key, bytes, width, height)
     VALUES ('day', $1, $2, $3, 48_000, 1080, 1920)`,
    [`hash-${SHORT_ID}`, SHORT_ID, 'card/bbbbbbbb-0000-0000-0000-000000000000.png'],
  );
}

describe('разбор метки из inline-запроса', () => {
  it('понимает сам short_id, метку sh_ и ссылку целиком', () => {
    expect(parseInlineQueryShortId(SHORT_ID)).toBe(SHORT_ID);
    expect(parseInlineQueryShortId(`sh_${SHORT_ID}`)).toBe(SHORT_ID);
    expect(parseInlineQueryShortId(`  sh_${SHORT_ID}  `)).toBe(SHORT_ID);
    expect(parseInlineQueryShortId(`https://t.me/astro_soul_bot?start=sh_${SHORT_ID}`)).toBe(
      SHORT_ID,
    );
  });

  it('чужое и мусор не перехватывает', () => {
    for (const value of ['', '   ', 'привет', 'sh_', 'sh_КОРОТКО', 'sh_0o1l234567', 'ref_123', 'https://t.me/x?start=ref_123']) {
      expect(parseInlineQueryShortId(value)).toBeNull();
    }
    // Метка из 10 символов, но не из нашего алфавита: `0`, `1`, `o`, `l`.
    expect(parseInlineQueryShortId('0o1l234567')).toBeNull();
  });
});

describe('inline_query → карточка в чат', () => {
  it('отвечает карточкой-картинкой со свежей подписью и подписью к ней', async () => {
    await cardFixture();

    const handled = await inline.handleQuery({ id: 'q-1', query: `sh_${SHORT_ID}` });

    expect(handled).toBe(true);
    expect(telegram.inlineAnswers).toHaveLength(1);

    const answer = telegram.inlineAnswers[0];
    expect(answer?.queryId).toBe('q-1');
    expect(answer?.results).toHaveLength(1);

    const result = answer?.results[0];
    expect(result?.type).toBe('photo');
    expect(result?.id).toBe(SHORT_ID);
    expect(result?.caption).toBe('Мне тут сделали разбор личности — залипательно');
    expect(result?.photo_width).toBe(1080);
    expect(result?.photo_height).toBe(1920);
    expect(result?.photo_url).toMatch(/^https:\/\/api\.test\/api\/v1\/files\/card\/.+\.png\?sig=/u);

    // Подпись рабочая прямо сейчас: бот выпускает её сам, а не берёт из
    // пересланного сообщения, где она могла истечь.
    const url = new URL(result?.photo_url ?? '');
    const storage = ctx.app.get(FileStorageService);
    const key = url.pathname.replace('/api/v1/files/', '');
    expect(storage.verify(key, url.searchParams.get('sig') ?? undefined)).toBe('ok');
  });

  it('неизвестная метка и пустой запрос → пустой список, а не тишина', async () => {
    await inline.handleQuery({ id: 'q-2', query: 'sh_zzzzzzzzzz' });
    await inline.handleQuery({ id: 'q-3', query: '' });

    expect(telegram.inlineAnswers).toHaveLength(2);
    expect(telegram.inlineAnswers[0]?.results).toEqual([]);
    expect(telegram.inlineAnswers[1]?.results).toEqual([]);
  });

  it('inline-ответ не пишет событий продукта: показ карточки — не отправка', async () => {
    await cardFixture();

    await inline.handleQuery({ id: 'q-4', query: SHORT_ID });

    const rows = await ctx.db.query('SELECT 1 FROM events');
    expect(rows).toHaveLength(0);
  });
});

describe('состояние inline-режима', () => {
  it('включён → `on`', async () => {
    telegram.inlineMode = true;
    await expect(inline.checkMode()).resolves.toBe('on');
  });

  it('выключен → `off`: BotFather главнее кода, но молчать нельзя', async () => {
    telegram.inlineMode = false;
    await expect(inline.checkMode()).resolves.toBe('off');
  });

  it('Bot API не ответил → `unknown`, а не «выключен»', async () => {
    telegram.getMeError = true;
    await expect(inline.checkMode()).resolves.toBe('unknown');
  });
});

describe('вебхук', () => {
  it('маршрутизирует `inline_query` в обработчик', async () => {
    await cardFixture();

    await request(ctx.app.getHttpServer())
      .post(`/api/v1/internal/telegram/webhook/${TEST_WEBHOOK_SECRET}`)
      .set('x-telegram-bot-api-secret-token', TEST_WEBHOOK_SECRET)
      .send({ update_id: 1, inline_query: { id: 'q-5', from: { id: 1 }, query: `sh_${SHORT_ID}` } })
      .expect(200);

    expect(telegram.inlineAnswers.map((answer) => answer.queryId)).toEqual(['q-5']);
  });
});
