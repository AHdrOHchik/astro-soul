import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { INIT_DATA_HEADER } from '../src/modules/auth/init-data';
import type { CardBuildRequest } from '../src/modules/astro/astro.client';
import { createTestContext, truncateAll, type TestContext } from './test-app';
import { signInitData } from './init-data-fixture';
import { FICTIONAL_USER, TEST_BOT_TOKEN } from './test-env';
import { makeFakeAstro } from './fake-astro';

/**
 * Карточки шеринга (контракт 1.6.8, итерация 32).
 *
 * Проверяется то, что нельзя увидеть на скриншоте:
 *
 *   1. **Ничего персонального.** В карточке нет ни имени, ни даты/времени/места
 *      рождения — ни в тексте, ни в байтах; у `share_cards` вообще нет колонки
 *      `user_id` (это проверяется по схеме, а не по обещанию).
 *   2. **Ссылка без чужих идентификаторов.** `short_id` выводится из хеша
 *      содержимого: `user_id` и `report_id` в ссылку не попадают.
 *   3. **Кэш по содержимому.** Две одинаковые карточки — один файл, одна строка,
 *      один рендер.
 *   4. **Совместимость не шарится**: `kind: "compat"` — `404` с объяснением.
 *   5. **Подпись.** Ссылка ведёт на наш домен, отдаётся только по `sig`.
 */

const BIRTH = {
  birth_date: '1994-05-17',
  birth_time: '14:20',
  time_precision: 'exact',
  // Название места намеренно «узнаваемое»: если оно попадёт в карточку, тест
  // это увидит по байтам запроса к рендереру.
  birth_place: { name: 'Тестоград', country: 'RU', lat: 55.7558, lon: 37.6173, tz: 'Europe/Moscow' },
  consent: { accepted: true, version: '2026-11-10' },
};

function initDataFor(userId: number = FICTIONAL_USER.id): string {
  return signInitData({ botToken: TEST_BOT_TOKEN, user: { ...FICTIONAL_USER, id: userId } });
}

interface ShareCardBody {
  readonly url: string;
  readonly share_url: string | null;
  readonly expires_at: string;
  readonly caption: string;
}

let ctx: TestContext;
/** Что именно ушло в рендерер: по этому и проверяется «нет ПДн». */
const cardCalls: CardBuildRequest[] = [];

beforeAll(async () => {
  const fake = makeFakeAstro();
  ctx = await createTestContext({
    astro: {
      ...fake,
      buildCard(input: CardBuildRequest) {
        cardCalls.push(input);
        return fake.buildCard(input);
      },
    },
    env: { PUBLIC_API_URL: 'https://api.test' },
  });
});

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  await truncateAll(ctx.db);
  cardCalls.length = 0;
});

async function userWithChart(): Promise<{ userId: string; chartId: string }> {
  const created = await request(ctx.app.getHttpServer())
    .post('/api/v1/charts')
    .set(INIT_DATA_HEADER, initDataFor())
    .send(BIRTH)
    .expect(201);

  const user = await ctx.db.queryOne<{ id: string }>(`SELECT id FROM users`);

  return {
    userId: user?.id ?? '',
    chartId: (created.body as { chart: { chart_id: string } }).chart.chart_id,
  };
}

async function paidReport(userId: string, chartId: string, core: string): Promise<string> {
  await ctx.db.query(
    `INSERT INTO entitlements (user_id, kind, status, chart_id) VALUES ($1, 'report', 'active', $2)`,
    [userId, chartId],
  );

  const report = await ctx.db.queryOne<{ id: string }>(
    `INSERT INTO reports
       (chart_id, user_id, kind, status, prompt_version, report_structure_version, chapters)
     VALUES ($1, $2, 'report', 'ready', 'prompts_v1.4', 'structure_v1', $3::jsonb)
     RETURNING id`,
    [
      chartId,
      userId,
      JSON.stringify([
        { key: 'core', title: 'Ядро', order: 0, body_md: core },
        { key: 'summary', title: 'Итог', order: 1, body_md: 'Действуй маленькими шагами.' },
      ]),
    ],
  );

  return report?.id ?? '';
}

function shareCard(kind: string, userId?: number) {
  return request(ctx.app.getHttpServer())
    .post('/api/v1/share/card')
    .set(INIT_DATA_HEADER, initDataFor(userId))
    .send({ kind });
}

describe('POST /share/card — карточка дня', () => {
  it('доступна всем (без подписки): знак Луны, фаза, дата и подпись', async () => {
    await userWithChart();

    const response = await shareCard('day').expect(200);
    const body = response.body as ShareCardBody;

    expect(body.url).toMatch(/^https:\/\/api\.test\/api\/v1\/files\/card\/[0-9a-f-]+\.png\?sig=/u);
    expect(body.expires_at).toMatch(/Z$/u);
    expect(body.caption).toBe('Мне тут сделали разбор личности — залипательно');

    const call = cardCalls[0];
    expect(call?.kind).toBe('day');
    expect(call?.title).toMatch(/^Луна в /u);
    expect(call?.moon_illumination).toBeGreaterThanOrEqual(0);
    expect(call?.moon_illumination).toBeLessThanOrEqual(1);
    // Дата в карточке — сегодняшняя, а не дата рождения.
    expect(call?.lines.at(-1)).toMatch(/^\d{1,2} [а-я]+ \d{4}$/u);
  });

  it('`share_url` — постоянная ссылка в бота, а не ссылка на файл', async () => {
    await userWithChart();

    const body = (await shareCard('day').expect(200)).body as ShareCardBody;

    // Имя бота берётся из окружения сервера: клиент его не знает и знать не
    // должен, иначе оно захардкодится во фронте.
    expect(body.share_url).toMatch(/^https:\/\/t\.me\/astro_soul_test_bot\?start=sh_[abcdefghijkmnpqrstuvwxyz23456789]{10}$/u);
    // Ни подписи файла, ни пути к файлу: это разные поля с разным сроком жизни.
    expect(body.share_url).not.toContain('sig=');
    expect(body.share_url).not.toContain('/files/');
    // Файловая ссылка при этом остаётся подписанной и приватной.
    expect(body.url).toContain('sig=');

    // `short_id` в ссылке выводится из содержимого карточки, а не из человека.
    const shortId = new URL(body.share_url ?? '').searchParams.get('start')?.slice('sh_'.length);
    const row = await ctx.db.queryOne<{ short_id: string; content_hash: string }>(
      'SELECT short_id, content_hash FROM share_cards',
    );
    expect(shortId).toBe(row?.short_id);
    expect(row?.content_hash).not.toContain(shortId ?? 'zzzz');
    // Ни `user_id`, ни `report_id` в карточке и её метке нет вовсе.
    expect(JSON.stringify(row)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/u);
  });

  it('подпись без запрещённых слов: «астрология», «гороскоп», «предсказание»', async () => {
    await userWithChart();

    const body = (await shareCard('day').expect(200)).body as ShareCardBody;
    const lower = body.caption.toLowerCase();

    for (const word of ['астролог', 'гороскоп', 'предсказан']) {
      expect(lower).not.toContain(word);
    }
    // Одна строка, а не абзац: её вставляют как есть.
    expect(body.caption).not.toContain('\n');
  });

  it('без ПДн: ни имени, ни даты/времени/места рождения в том, что рисуется', async () => {
    await userWithChart();

    await shareCard('day').expect(200);
    const serialized = JSON.stringify(cardCalls[0] ?? {});

    for (const pii of ['1994', '14:20', 'Тестоград', '55.7558', '37.6173', 'Тест', 'test_user']) {
      expect(serialized).not.toContain(pii);
    }
  });

  it('ссылка в подвале: t.me/<bot>?start=sh_<short_id>, и short_id не про человека', async () => {
    const { userId } = await userWithChart();

    await shareCard('day').expect(200);
    const footer = cardCalls[0]?.footer ?? '';

    expect(footer).toMatch(/^t\.me\/astro_soul_test_bot\?start=sh_[abcdefghijkmnpqrstuvwxyz23456789]{10}$/u);

    const shortId = footer.split('sh_')[1] ?? '';
    expect(shortId).not.toBe(userId);
    expect(footer).not.toContain(userId);

    const row = await ctx.db.queryOne<{ short_id: string }>(`SELECT short_id FROM share_cards`);
    expect(row?.short_id).toBe(shortId);
  });

  it('в схеме `share_cards` нет связи с человеком', async () => {
    const columns = await ctx.db.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'share_cards'`,
    );
    const names = columns.map((column) => column.column_name);

    expect(names).not.toContain('user_id');
    expect(names).not.toContain('report_id');
    expect(names).not.toContain('chart_id');
  });

  it('кэш по содержимому: второй запрос не рендерит карточку заново', async () => {
    await userWithChart();

    const first = (await shareCard('day').expect(200)).body as ShareCardBody;
    const second = (await shareCard('day').expect(200)).body as ShareCardBody;

    expect(cardCalls).toHaveLength(1);
    const keyOf = (url: string): string => new URL(url).pathname;
    expect(keyOf(second.url)).toBe(keyOf(first.url));

    const rows = await ctx.db.query(`SELECT id FROM share_cards`);
    expect(rows).toHaveLength(1);
  });

  it('карточка отдаётся по подписи и только по ней', async () => {
    await userWithChart();
    const body = (await shareCard('day').expect(200)).body as ShareCardBody;
    const url = new URL(body.url);

    const downloaded = await request(ctx.app.getHttpServer())
      .get(`${url.pathname}${url.search}`)
      .expect(200);
    expect(downloaded.headers['content-type']).toContain('image/png');
    expect(downloaded.headers['cache-control']).toBe('private, no-store');

    await request(ctx.app.getHttpServer()).get(url.pathname).expect(403);
  });
});

describe('POST /share/card — колесо', () => {
  it('есть карта: 1080×1920, колесо внутри, ни даты, ни места', async () => {
    await userWithChart();

    const body = (await shareCard('wheel').expect(200)).body as ShareCardBody;
    expect(body.url).toContain('/api/v1/files/card/');

    const call = cardCalls[0];
    expect(call?.kind).toBe('wheel');
    expect(call?.title).toBe('Моя натальная карта');
    expect(call?.wheel_png_base64).not.toBeNull();

    const serialized = JSON.stringify({ title: call?.title, lines: call?.lines, footer: call?.footer });
    for (const pii of ['1994', '14:20', 'Тестоград']) {
      expect(serialized).not.toContain(pii);
    }

    const row = await ctx.db.queryOne<{ width: number; height: number }>(
      `SELECT width, height FROM share_cards WHERE kind = 'wheel'`,
    );
    expect(row).toMatchObject({ width: 1080, height: 1920 });
  });

  it('без карты → 403 chart_required', async () => {
    const { userId } = await userWithChart();
    await ctx.db.query(`DELETE FROM charts WHERE user_id = $1`, [userId]);

    const response = await shareCard('wheel').expect(403);

    expect(response.body.details?.reason).toBe('chart_required');
    expect(cardCalls).toHaveLength(0);
  });
});

describe('POST /share/card — цитата', () => {
  it('без оплаченного разбора → 403 report_not_paid', async () => {
    await userWithChart();

    const response = await shareCard('insight').expect(403);

    expect(response.body.details?.reason).toBe('report_not_paid');
  });

  it('оплаченный разбор: цитата 2–3 предложения без терминов, 1080×1080', async () => {
    const { userId, chartId } = await userWithChart();
    await paidReport(
      userId,
      chartId,
      'Ты держишь темп, когда вокруг шумно. Тебе важно сначала понять, потом действовать. ' +
        'В разговорах ты выбираешь честность. ' +
        'Солнце в карте отвечает за волю, а Луна — за настроение.',
    );

    const body = (await shareCard('insight').expect(200)).body as ShareCardBody;
    expect(body.url).toContain('/api/v1/files/card/');

    const title = cardCalls[0]?.title ?? '';
    expect(title.startsWith('«')).toBe(true);
    expect(title.endsWith('»')).toBe(true);
    // Предложение с терминами выброшено, остальные — на месте.
    expect(title).toContain('Ты держишь темп');
    expect(title).not.toContain('Солнце');
    expect(title).not.toContain('Луна');
    expect(title).not.toContain('карте');

    const row = await ctx.db.queryOne<{ width: number; height: number }>(
      `SELECT width, height FROM share_cards WHERE kind = 'insight'`,
    );
    expect(row).toMatchObject({ width: 1080, height: 1080 });
  });

  it('в «Ядре» одни термины → 403 insight_unavailable, а не цитата с терминами', async () => {
    const { userId, chartId } = await userWithChart();
    await paidReport(
      userId,
      chartId,
      'Солнце в Овне даёт волю. Луна в Рыбах даёт чувствительность. Асцендент в Деве уточняет карту.',
    );

    const response = await shareCard('insight').expect(403);

    expect(response.body.details?.reason).toBe('insight_unavailable');
    expect(cardCalls).toHaveLength(0);
  });

  it('чужой разбор не цитируется: у второго человека своей оплаты нет', async () => {
    const { userId, chartId } = await userWithChart();
    await paidReport(userId, chartId, 'Ты держишь темп, когда вокруг шумно. И это работает.');

    // Второй человек: у него даже карты нет — вопрос прав решается до текста.
    const response = await shareCard('insight', 777_000_222).expect(403);
    expect(response.body.details?.reason).toBe('report_not_paid');
  });
});

describe('POST /share/card — чего нет', () => {
  it('kind: "compat" → 404 share_compat_not_available с объяснением', async () => {
    await userWithChart();

    const response = await shareCard('compat').expect(404);

    expect(response.body.details?.reason).toBe('share_compat_not_available');
    expect(response.body.message).toContain('партнёр');
    expect(cardCalls).toHaveLength(0);
  });

  it('неизвестный вид → 422 с полем kind', async () => {
    await userWithChart();

    const response = await shareCard('story').expect(422);

    expect(response.body.code).toBe('VALIDATION_FAILED');
    expect(response.body.details?.field_errors?.[0]?.field).toBe('kind');
  });
});

describe('аналитика карточек', () => {
  it('`share_card_created` — только вид, размер и время сборки; без получателя и текста', async () => {
    await userWithChart();
    await shareCard('day').expect(200);

    const row = await ctx.db.queryOne<{ name: string; props: Record<string, unknown> }>(
      `SELECT name, props FROM events WHERE name = 'share_card_created' ORDER BY id DESC LIMIT 1`,
    );

    expect(row?.name).toBe('share_card_created');
    // `template_version` (1.6.12) — часть события с тех пор, как версия вёрстки
    // вошла в ключ кэша: без неё «cached» ничего не объясняет.
    expect(Object.keys(row?.props ?? {}).sort()).toEqual([
      'build_ms',
      'bytes',
      'cached',
      'kind',
      'template_version',
    ]);
    expect(row?.props).toMatchObject({ kind: 'day', cached: false });
    expect(typeof row?.props['bytes']).toBe('number');
    expect(typeof row?.props['build_ms']).toBe('number');
    // Ни имени получателя, ни текста карточки: событие техническое.
    expect(JSON.stringify(row?.props)).not.toContain('Тест');
    expect(JSON.stringify(row?.props)).not.toContain('Луна в');
  });

  it('кэш-попадание помечено `cached: true` и не врёт про время сборки', async () => {
    await userWithChart();

    await shareCard('day').expect(200);
    await shareCard('day').expect(200);

    const rows = await ctx.db.query<{ props: Record<string, unknown> }>(
      `SELECT props FROM events WHERE name = 'share_card_created' ORDER BY id`,
    );

    expect(rows).toHaveLength(2);
    expect(rows[0]?.props['cached']).toBe(false);
    expect(rows[1]?.props['cached']).toBe(true);
    // Карточку не рисовали — значит и времени сборки у события нет.
    expect(rows[1]?.props['build_ms']).toBeUndefined();
  });

  it('сервер не пишет `share_sent`: отправку сообщает клиент, а не генерация', async () => {
    await userWithChart();

    await shareCard('day').expect(200);
    await shareCard('wheel').expect(200);

    const rows = await ctx.db.query<{ name: string }>(
      `SELECT name FROM events WHERE name IN ('share_sent', 'share_card_opened')`,
    );
    expect(rows).toHaveLength(0);
  });
});
