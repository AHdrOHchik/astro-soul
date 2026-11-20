import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FileStorageService } from '../src/modules/files/file-storage.service';
import { TelegramStartService } from '../src/modules/telegram/telegram-start.service';
import { createTestContext, truncateAll, type TestContext } from './test-app';
import { makeFakeAstro } from './fake-astro';
import { makeFakeTelegram, type FakeTelegram } from './fake-telegram';

/**
 * `/start sh_<short_id>` — ссылка из пересланной карточки (контракт 1.6.8).
 *
 * Смысл обработчика в вирусной петле: человек нажал ссылку в чужой карточке, и
 * бот показывает ту же картинку с кнопкой «Открыть». Поэтому проверяется, что
 * бот отдаёт **свежую подписанную** ссылку (чужая подпись живёт 24 часа и могла
 * истечь), что подпись ведёт на наш домен и что неизвестная метка не роняет
 * обработчик.
 *
 * Отдельно: `/start chart_<uuid>` продолжает работать — префиксы не спорят.
 */

let ctx: TestContext;
let telegram: FakeTelegram;
let start: TelegramStartService;

beforeAll(async () => {
  telegram = makeFakeTelegram();
  ctx = await createTestContext({
    astro: makeFakeAstro(),
    telegram,
    env: { MINI_APP_URL: 'https://app.test', PUBLIC_API_URL: 'https://api.test' },
  });
  start = ctx.app.get(TelegramStartService);
});

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  await truncateAll(ctx.db);
  telegram.messages.length = 0;
  telegram.photos.length = 0;
});

/** Ровно 10 символов алфавита `shortIdOf`: без `0`, `1`, `o`, `l`. */
const SHORT_ID = 'k7m2p9x4qz';

async function cardFixture(kind = 'day', shortId = SHORT_ID): Promise<void> {
  await ctx.db.query(
    `INSERT INTO share_cards (kind, content_hash, short_id, storage_key, bytes, width, height)
     VALUES ($1, $2, $3, $4, 48_000, 1080, 1920)`,
    [kind, `hash-${shortId}`, shortId, `card/aaaaaaaa-0000-0000-0000-000000000000.png`],
  );
}

describe('/start sh_<short_id>', () => {
  it('отдаёт карточку картинкой со свежей подписью и подписью к карточке', async () => {
    await cardFixture();

    const handled = await start.handleMessage({
      chat: { id: 4242 },
      text: `/start sh_${SHORT_ID}`,
    });

    expect(handled).toBe(true);
    expect(telegram.photos).toHaveLength(1);

    const photo = telegram.photos[0];
    expect(photo?.chatId).toBe(4242);
    expect(photo?.caption).toBe('Мне тут сделали разбор личности — залипательно');
    expect(photo?.photo).toMatch(/^https:\/\/api\.test\/api\/v1\/files\/card\/.+\.png\?sig=/u);

    // Подпись валидна прямо сейчас: это ключевое — бот берёт свежую, а не ту,
    // что лежала в пересланном сообщении.
    const url = new URL(photo?.photo ?? '');
    const storage = ctx.app.get(FileStorageService);
    const key = url.pathname.replace('/api/v1/files/', '');
    expect(url.searchParams.get('sig')).toMatch(/^\d+\.[A-Za-z0-9_-]+$/u);
    expect(storage.verify(key, url.searchParams.get('sig') ?? undefined)).toBe('ok');

    // События без ПДн: вид и канал, ни отправителя, ни получателя.
    const events = await ctx.db.query<{ name: string; props: Record<string, unknown> }>(
      `SELECT name, props FROM events ORDER BY id`,
    );
    expect(events.map((event) => event.name)).toEqual(['share_card_opened', 'share_sent']);
    expect(events[0]?.props).toMatchObject({ kind: 'day', channel: 'link' });
    // `share_sent` = карточка ушла в чат: единственная отправка, которую сервер
    // видит своими глазами.
    expect(events[1]?.props).toMatchObject({ kind: 'day', channel: 'telegram' });
  });

  it('неизвестная метка → текст и кнопка, а не тишина', async () => {
    const handled = await start.handleMessage({ chat: { id: 1 }, text: '/start sh_zzzzzzzzzz' });

    expect(handled).toBe(true);
    expect(telegram.photos).toHaveLength(0);
    expect(telegram.messages).toHaveLength(1);
    expect(telegram.messages[0]?.text).toContain('Карточки больше нет');
  });

  it('метка не нашего формата не перехватывается', async () => {
    const handled = await start.handleMessage({ chat: { id: 1 }, text: '/start sh_КОРОТКО' });

    expect(handled).toBe(false);
    expect(telegram.messages).toHaveLength(0);
  });

  it('`/start chart_<uuid>` по-прежнему открывает карту', async () => {
    const handled = await start.handleMessage({
      chat: { id: 7 },
      text: '/start chart_5c1f0f0e-0000-4000-8000-000000000000',
    });

    expect(handled).toBe(true);
    expect(telegram.messages).toHaveLength(1);
    expect(telegram.messages[0]?.text).toContain('Твоя карта готова');
  });
});
