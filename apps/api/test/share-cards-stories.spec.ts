import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { INIT_DATA_HEADER } from '../src/modules/auth/init-data';
import type { CardBuildRequest } from '../src/modules/astro/astro.client';
import {
  SHARE_TEMPLATE_VERSION,
  CLASSIC_TEMPLATE_VERSION,
  identityPhrases,
  templateVersionOf,
  localDateIn,
  formatRuDay,
  prepositional,
  phaseWord,
  MOON_ADVICE,
  IDENTITY_INVITE,
  IDENTITY_TITLE,
  SHARE_CAPTION,
} from '../src/modules/share/share.service';
import { INLINE_KINDS } from '../src/modules/share/share.repository';
import { DISCLAIMER } from '../src/modules/reports/validators';
import { createTestContext, truncateAll, type TestContext } from './test-app';
import { signInitData } from './init-data-fixture';
import { FICTIONAL_USER, TEST_BOT_TOKEN } from './test-env';
import { makeFakeAstro } from './fake-astro';

/**
 * Карточки-сторис (контракт 1.6.12, итерация 37): `identity`, `moon` и `day` на
 * общем шаблоне.
 *
 * Проверяется то, чего не видно на скриншоте:
 *
 *   1. **Общий шаблон.** Все три карточки 1080×1920 и несут имя продукта,
 *      подсказку для поиска и тот же дисклеймер, что прогноз. Пустой
 *      `BRAND_NAME` — `503`, а не «Astro Soul по умолчанию».
 *   2. **Детерминизм `identity`.** Один и тот же разбор даёт один и тот же файл:
 *      текст режется по правилам, модель не вызывается.
 *   3. **`identity` без оплаты** — `403 report_not_paid`; меньше трёх подходящих
 *      фраз — `422 not_enough_identity_lines`, а не карточка с двумя.
 *   4. **`moon` без карты и без подписки** — `200`: это вирусный вход. Плохой
 *      `tz` — `422`, а не 500.
 *   5. **Кэш версионирован:** ключ `(kind, content_hash, template_version)`,
 *      поэтому старая вёрстка не отдаётся как новая карточка.
 *   6. **Ничего персонального** — ни в том, что ушло в рендерер, ни в байтах
 *      файла.
 *
 * `wheel` и `insight` в этом файле только как контроль: у них прежняя вёрстка и
 * `classic-1`.
 */

const BIRTH = {
  birth_date: '1994-05-17',
  birth_time: '14:20',
  time_precision: 'exact',
  // Название места намеренно «узнаваемое»: если оно попадёт в карточку, тест
  // это увидит в том, что ушло в рендерер, и в байтах файла.
  birth_place: { name: 'Тестоград', country: 'RU', lat: 55.7558, lon: 37.6173, tz: 'Europe/Moscow' },
  consent: { accepted: true, version: '2026-11-10' },
};

/**
 * «Ядро» с подходящими фразами и приманками: термины, проценты и родовые формы
 * обязаны быть отброшены, иначе карточка — оценка человека, а не наблюдение.
 */
const CORE_OK =
  'Ты замечаешь настроение комнаты раньше, чем кто-то успевает сказать слово. ' +
  'У тебя есть привычка сначала проверять факты, а потом уже спорить. ' +
  'Твой способ восстанавливаться — тишина и один длинный разговор с близким. ' +
  'Ты склонна доверять первому впечатлению на 80% — так решает Луна в карте.';

const PII = ['1994', '14:20', 'Тестоград', '55.75', '37.61'];

let ctx: TestContext;
/** Что именно ушло в рендерер: по этому и проверяется «нет ПДн». */
const cardCalls: CardBuildRequest[] = [];
/** Движок как он есть: эталон для «карточка не выдумала фазу». */
const engine = makeFakeAstro();

function initDataFor(userId: number = FICTIONAL_USER.id): string {
  return signInitData({ botToken: TEST_BOT_TOKEN, user: { ...FICTIONAL_USER, id: userId } });
}

interface ShareCardBody {
  readonly url: string;
  readonly share_url: string | null;
  readonly expires_at: string;
  readonly caption: string;
}

interface CardRow {
  readonly kind: string;
  readonly content_hash: string;
  readonly template_version: string;
  readonly short_id: string;
  readonly storage_key: string;
  readonly width: number;
  readonly height: number;
}

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

function shareCard(kind: string, options: { tz?: string; userId?: number } = {}) {
  return request(ctx.app.getHttpServer())
    .post('/api/v1/share/card')
    .set(INIT_DATA_HEADER, initDataFor(options.userId))
    .send({ kind, ...(options.tz === undefined ? {} : { tz: options.tz }) });
}

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

async function withReport(core: string): Promise<{ userId: string; chartId: string }> {
  const owner = await userWithChart();
  await paidReport(owner.userId, owner.chartId, core);
  return owner;
}

async function cardRows(): Promise<CardRow[]> {
  return ctx.db.query<CardRow>(
    `SELECT kind, content_hash, template_version, short_id, storage_key, width, height
       FROM share_cards ORDER BY id`,
  );
}

async function cardEvents(): Promise<{ cached: unknown; template_version: unknown }[]> {
  return ctx.db.query<{ cached: unknown; template_version: unknown }>(
    `SELECT props->>'cached' AS cached, props->>'template_version' AS template_version
       FROM events WHERE name = 'share_card_created' ORDER BY id`,
  );
}

async function fileBytes(row: CardRow): Promise<string> {
  const root = process.env['FILE_STORAGE_DIR'] ?? '';
  return (await readFile(join(root, row.storage_key))).toString('latin1');
}

describe('шаблон сторис — то, что обязано быть на каждой карточке', () => {
  it('`day`, `identity` и `moon` несут имя продукта, подсказку, дисклеймер и подвал', async () => {
    await withReport(CORE_OK);

    await shareCard('day').expect(200);
    await shareCard('identity').expect(200);
    await shareCard('moon').expect(200);

    expect(cardCalls.map((call) => call.kind)).toEqual(['day', 'identity', 'moon']);

    for (const call of cardCalls) {
      // Имя продукта — из конфига, а не из username бота и не «по умолчанию».
      expect(call.brand_name).toBe('Сонарий');
      expect(call.brand_hint).toBe('ищи в Telegram: Сонарий');
      expect(call.disclaimer).toBe(DISCLAIMER);
      expect(call.footer).toMatch(/^t\.me\//u);
    }
  });

  it('`wheel` и `insight` остались на старой вёрстке: без бренда и без дисклеймера', async () => {
    await withReport(CORE_OK);

    await shareCard('wheel').expect(200);
    await shareCard('insight').expect(200);

    for (const call of cardCalls) {
      expect(call.brand_name).toBeNull();
      expect(call.brand_hint).toBeNull();
      expect(call.disclaimer).toBeNull();
    }
  });

  it('все три карточки 1080×1920, цитата — прежние 1080×1080', async () => {
    await withReport(CORE_OK);

    await shareCard('day').expect(200);
    await shareCard('identity').expect(200);
    await shareCard('moon').expect(200);
    await shareCard('insight').expect(200);

    const rows = await cardRows();
    const byKind = new Map(rows.map((row) => [row.kind, row]));

    for (const kind of ['day', 'identity', 'moon']) {
      expect(byKind.get(kind)).toMatchObject({ width: 1080, height: 1920 });
    }
    expect(byKind.get('insight')).toMatchObject({ width: 1080, height: 1080 });
  });

  it('пустой `BRAND_NAME` → 503 brand_name_missing: имя продукта не подставляется', async () => {
    const bare = await createTestContext({
      astro: makeFakeAstro(),
      // Пустое значение в `.env` — тот же случай, что «не задано».
      env: { BRAND_NAME: '' },
    });

    try {
      const owner = await request(bare.app.getHttpServer())
        .post('/api/v1/charts')
        .set(INIT_DATA_HEADER, initDataFor())
        .send(BIRTH)
        .expect(201);
      expect(owner.status).toBe(201);

      for (const kind of ['day', 'moon']) {
        const response = await request(bare.app.getHttpServer())
          .post('/api/v1/share/card')
          .set(INIT_DATA_HEADER, initDataFor())
          .send({ kind })
          .expect(503);

        expect((response.body as { details: { reason: string } }).details.reason).toBe(
          'brand_name_missing',
        );
      }

      const rows = await bare.db.query<{ kind: string }>('SELECT kind FROM share_cards');
      expect(rows).toHaveLength(0);
    } finally {
      await bare.close();
      // Окружение читается на каждый запрос, а не один раз при старте: пустое
      // имя продукта из этого теста иначе осталось бы в следующих.
      process.env['BRAND_NAME'] = 'Сонарий';
    }
  });

  it('версия шаблона: сторис — `stories-1`, а `TEMPLATE_VERSION` в сайдкаре тот же', async () => {
    expect(templateVersionOf('day')).toBe(SHARE_TEMPLATE_VERSION);
    expect(templateVersionOf('identity')).toBe(SHARE_TEMPLATE_VERSION);
    expect(templateVersionOf('moon')).toBe(SHARE_TEMPLATE_VERSION);
    expect(templateVersionOf('wheel')).toBe(CLASSIC_TEMPLATE_VERSION);
    expect(templateVersionOf('insight')).toBe(CLASSIC_TEMPLATE_VERSION);

    // Дублирование версии в двух языках — источник расхождения «кэш попал, а
    // картинка старая». Тест читает константу из Python, а не верит комментарию.
    const python = await readFile(
      join(process.cwd(), '..', '..', 'packages', 'astro', 'astro', 'cards.py'),
      'utf8',
    );
    expect(python).toContain(`TEMPLATE_VERSION: Final[str] = "${SHARE_TEMPLATE_VERSION}"`);
  });

  it('inline-режим знает все пять видов: `sh_<short_id>` не отдаёт пустоту', () => {
    expect([...INLINE_KINDS]).toEqual(['day', 'wheel', 'insight', 'identity', 'moon']);
  });
});

describe('карточка `identity` — «три вещи, которые правда про меня»', () => {
  it('три короткие фразы о поведении и приглашение внизу', async () => {
    await withReport(CORE_OK);

    await shareCard('identity').expect(200);

    const call = cardCalls[0];
    expect(call?.title).toBe(IDENTITY_TITLE);
    expect(call?.prompt).toBe(IDENTITY_INVITE);
    expect(call?.lines).toHaveLength(3);

    for (const line of call?.lines ?? []) {
      // Длина — по правилам отбора: короче 40 — обрывок, длиннее 120 — абзац.
      expect(line.length).toBeGreaterThanOrEqual(40);
      expect(line.length).toBeLessThanOrEqual(120);

      // Второе лицо: это наблюдение о человеке, а не описание типа.
      expect(line).toMatch(/(^|[^а-яё])(ты|тебя|тебе|тобой|твой|твоя|тво[еи]й)([^а-яё]|$)/iu);

      // Ни терминов, ни процентов, ни родовых форм: «ты склонна» и «на 80%» —
      // оценка и чужой род.
      const lower = line.toLowerCase();
      for (const word of ['овен', 'луна', 'солнц', 'карт', 'асцендент', 'процент']) {
        expect(lower).not.toContain(word);
      }
      expect(line).not.toContain('%');
      for (const form of ['склонен', 'склонна', 'готова', 'уверена', 'должна', 'сама ']) {
        expect(lower).not.toContain(form);
      }
    }

    // Приманка с терминами и процентами в карточку не попала.
    expect(call?.lines.join(' ')).not.toContain('Луна');
    expect(call?.lines.join(' ')).not.toContain('80');
  });

  it('детерминизм: тот же разбор дважды — один файл, один рендер', async () => {
    await withReport(CORE_OK);

    const first = (await shareCard('identity').expect(200)).body as ShareCardBody;
    const second = (await shareCard('identity').expect(200)).body as ShareCardBody;

    const [row] = await cardRows();
    expect(await cardRows()).toHaveLength(1);
    expect(cardCalls).toHaveLength(1);
    expect(second.share_url).toBe(first.share_url);
    expect(second.url.split('?')[0]).toBe(first.url.split('?')[0]);
    expect(row?.template_version).toBe(SHARE_TEMPLATE_VERSION);

    // Тот же текст, что отдал бы `identityPhrases` — карточка не «переписала»
    // разбор по-своему.
    expect(cardCalls[0]?.lines).toEqual(identityPhrases(CORE_OK));
  });

  it('без оплаченного разбора → 403 report_not_paid', async () => {
    await userWithChart();

    const response = await shareCard('identity').expect(403);

    expect((response.body as { details: { reason: string } }).details.reason).toBe(
      'report_not_paid',
    );
    expect(cardCalls).toHaveLength(0);
    expect(await cardRows()).toHaveLength(0);
  });

  it('меньше трёх фраз → 422 not_enough_identity_lines: две вместо трёх — не карточка', async () => {
    await withReport(
      'Ты держишь темп, когда вокруг шумно и все куда-то спешат, и это видно. ' +
        'Луна в карте отвечает за настроение, а Солнце — за волю и вкус.',
    );

    const response = await shareCard('identity').expect(422);

    expect((response.body as { details: { reason: string } }).details.reason).toBe(
      'not_enough_identity_lines',
    );
    expect(cardCalls).toHaveLength(0);
    expect(await cardRows()).toHaveLength(0);
  });

  it('чужой разбор не уходит в карточку: у второго человека своей оплаты нет', async () => {
    await withReport(CORE_OK);

    const response = await shareCard('identity', { userId: 777_000_222 }).expect(403);

    expect((response.body as { details: { reason: string } }).details.reason).toBe(
      'report_not_paid',
    );
  });
});

describe('карточка `moon` — вход в воронку без профиля', () => {
  it('без карты и без подписки → 200: знак, фаза, освещённость, совет по фазе', async () => {
    // Карту не строим вовсе: именно в этом смысл карточки.
    const body = (await shareCard('moon', { userId: 777_000_333 }).expect(200))
      .body as ShareCardBody;

    expect(body.url).toContain('/api/v1/files/card/');
    expect(body.caption).toBe(SHARE_CAPTION);

    const rows = await cardRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'moon', width: 1080, height: 1920 });

    // Ни карты, ни подписки у человека нет — и это не помешало.
    const charts = await ctx.db.query('SELECT 1 FROM charts');
    const subs = await ctx.db.query('SELECT 1 FROM subscriptions');
    expect(charts).toHaveLength(0);
    expect(subs).toHaveLength(0);

    const call = cardCalls[0];
    expect(call?.title).toMatch(/^Луна в /u);
    expect(call?.lines).toHaveLength(3);
    expect(call?.lines[1]).toBe(
      MOON_ADVICE[(call?.lines[0] ?? '').split(',')[0]?.toLowerCase() ?? ''] ??
        'Не начинай того, что можно отложить на завтра.',
    );
    expect(call?.lines.at(-1)).toMatch(/^\d{1,2} [а-я]+ \d{4}$/u);
    expect(call?.prompt).toBeNull();
  });

  it('фаза, знак и освещённость — те же, что у прогноза на ту же дату', async () => {
    await shareCard('moon').expect(200);

    const today = new Date().toISOString().slice(0, 10);
    const facts = await engine.moonFacts(today, 'UTC');

    const call = cardCalls[0];
    expect(call?.title).toBe(`Луна в ${prepositional(facts.moon.sign)}`);
    expect(call?.lines[0]).toBe(
      `${phaseWord(facts.moon.phase)}, освещённость ${String(
        Math.round(facts.moon.illumination * 100),
      )}%`,
    );
    expect(call?.moon_illumination).toBe(facts.moon.illumination);
    expect(call?.lines.at(-1)).toBe(formatRuDay(facts.date));
  });

  it('`tz` учитывается: «сегодня» — по поясу, а не по UTC сервера', async () => {
    const zone = 'Pacific/Kiritimati';

    await shareCard('moon', { tz: zone }).expect(200);

    const call = cardCalls[0];
    expect(call?.lines.at(-1)).toBe(formatRuDay(localDateIn(zone, new Date())));
  });

  it('неизвестный пояс → 422 share_tz_unknown с полем tz', async () => {
    const response = await shareCard('moon', { tz: 'Mars/Olympus' }).expect(422);

    const details = (response.body as { details: { reason: string; field_errors: { field: string }[] } })
      .details;
    expect(details.reason).toBe('share_tz_unknown');
    expect(details.field_errors[0]?.field).toBe('tz');
    expect(cardCalls).toHaveLength(0);
    expect(await cardRows()).toHaveLength(0);
  });

  it('анонимно нельзя: без initData карточка не собирается', async () => {
    await request(ctx.app.getHttpServer()).post('/api/v1/share/card').send({ kind: 'moon' }).expect(401);

    expect(cardCalls).toHaveLength(0);
  });
});

describe('кэш карточек версионирован вёрсткой', () => {
  it('строка старой вёрстки не отдаётся: строится новая карточка с `stories-1`', async () => {
    await withReport(CORE_OK);

    await shareCard('identity').expect(200);

    // Так выглядит строка, собранная до смены шаблона: тот же текст, другая
    // вёрстка и свой `short_id` (он тоже считается от версии — иначе старая
    // строка занимала бы короткую ссылку новой).
    await ctx.db.query(
      `UPDATE share_cards SET template_version = 'legacy-0', short_id = 'legacyrow0'`,
    );

    await shareCard('identity').expect(200);

    const rows = await cardRows();
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.content_hash)).size).toBe(1);
    expect(rows.map((row) => row.template_version).sort()).toEqual(['legacy-0', SHARE_TEMPLATE_VERSION]);

    const events = await cardEvents();
    expect(events.map((event) => event.cached)).toEqual(['false', 'false']);
    expect(events.every((event) => event.template_version === SHARE_TEMPLATE_VERSION)).toBe(true);

    // Третий запрос — уже кэш-попадание в новую версию.
    await shareCard('identity').expect(200);
    expect(await cardRows()).toHaveLength(2);
    expect((await cardEvents()).map((event) => event.cached)).toEqual(['false', 'false', 'true']);
  });
});

describe('ничего персонального — ни в рендерере, ни в файле', () => {
  it('`day`, `identity` и `moon`: ни даты, ни времени, ни места рождения', async () => {
    await withReport(CORE_OK);

    await shareCard('day').expect(200);
    await shareCard('identity').expect(200);
    await shareCard('moon').expect(200);

    for (const call of cardCalls) {
      const sent = JSON.stringify(call);
      for (const secret of PII) {
        expect(sent).not.toContain(secret);
      }
    }

    for (const row of await cardRows()) {
      const bytes = await fileBytes(row);
      for (const secret of PII) {
        expect(bytes).not.toContain(secret);
      }
    }
  });
});

describe('события новых карточек', () => {
  function event(name: string, props?: Record<string, string>) {
    return {
      name,
      occurred_at: new Date().toISOString(),
      ...(props === undefined ? {} : { props }),
    };
  }

  it('`share_sent` с `kind: "identity"` и `kind: "moon"` → 202', async () => {
    for (const kind of ['identity', 'moon']) {
      await request(ctx.app.getHttpServer())
        .post('/api/v1/events')
        .set(INIT_DATA_HEADER, initDataFor())
        .send({ events: [event('share_sent', { kind, channel: 'inline' })] })
        .expect(202);
    }

    const rows = await ctx.db.query<{ props: Record<string, unknown> }>(
      `SELECT props FROM events WHERE name = 'share_sent' ORDER BY id`,
    );
    expect(rows.map((row) => row.props['kind'])).toEqual(['identity', 'moon']);
  });

  it('`share_sent` с `kind: "compat"` → 422: такого вида нет', async () => {
    const response = await request(ctx.app.getHttpServer())
      .post('/api/v1/events')
      .set(INIT_DATA_HEADER, initDataFor())
      .send({ events: [event('share_sent', { kind: 'compat', channel: 'inline' })] })
      .expect(422);

    expect(
      (response.body as { details: { field_errors: { field: string }[] } }).details.field_errors,
    ).toEqual([
      { field: 'events.props.kind', message: 'Вид карточки — day, wheel, insight, identity или moon' },
    ]);

    expect(await ctx.db.query('SELECT 1 FROM events')).toHaveLength(0);
  });

  it('`share_saved` без `target` → 422, с `target` → 202 и запись', async () => {
    const missing = await request(ctx.app.getHttpServer())
      .post('/api/v1/events')
      .set(INIT_DATA_HEADER, initDataFor())
      .send({ events: [event('share_saved', { kind: 'moon' })] })
      .expect(422);

    expect(
      (missing.body as { details: { field_errors: { field: string }[] } }).details.field_errors,
    ).toEqual([{ field: 'events.props.target', message: 'Куда сохранили — gallery или telegram_story' }]);

    await request(ctx.app.getHttpServer())
      .post('/api/v1/events')
      .set(INIT_DATA_HEADER, initDataFor())
      .send({
        events: [event('share_saved', { kind: 'moon', target: 'telegram_story', url: 'https://x' })],
      })
      .expect(202);

    const rows = await ctx.db.query<{ props: Record<string, unknown> }>(
      `SELECT props FROM events WHERE name = 'share_saved'`,
    );
    expect(rows).toHaveLength(1);
    // Лишний ключ вырезан: «куда сохранили», а не что именно и по какой ссылке.
    expect(rows[0]?.props).toEqual({ kind: 'moon', target: 'telegram_story' });
  });
});

describe('метрика карточек по видам', () => {
  const ADMIN_TG_ID = String(777_000_444);
  let admin: TestContext;

  beforeAll(async () => {
    admin = await createTestContext({ astro: makeFakeAstro(), env: { ADMIN_TG_ID } });
  });

  afterAll(async () => {
    await admin.close();
  });

  it('`share_cards_created_24h` знает все пять видов, включая нули', async () => {
    await truncateAll(admin.db);

    // Строки кладём напрямую: метрика считает записи кэша, а не запросы.
    for (const kind of ['day', 'day', 'identity', 'moon']) {
      await admin.db.query(
        `INSERT INTO share_cards (kind, content_hash, template_version, short_id, storage_key, bytes, width, height)
         VALUES ($1, $2, 'stories-1', $3, $4, 100, 1080, 1920)`,
        [kind, `${kind}-${Math.random()}`, `sid${Math.random().toString(36).slice(2, 12)}`, 'card/x.png'],
      );
    }

    const response = await request(admin.app.getHttpServer())
      .get('/api/v1/admin/metrics')
      .set(INIT_DATA_HEADER, signInitData({ botToken: TEST_BOT_TOKEN, user: { ...FICTIONAL_USER, id: 777_000_444 } }))
      .expect(200);

    expect((response.body as { share_cards_created_24h: Record<string, number> }).share_cards_created_24h)
      .toEqual({ day: 2, wheel: 0, insight: 0, identity: 1, moon: 1 });
  });
});
