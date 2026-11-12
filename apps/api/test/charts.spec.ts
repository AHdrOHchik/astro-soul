import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { INIT_DATA_HEADER } from '../src/modules/auth/init-data';
import { createTestContext, truncateAll, type TestContext } from './test-app';
import { signInitData } from './init-data-fixture';
import { FICTIONAL_USER, TEST_BOT_TOKEN, TEST_PEPPER } from './test-env';
import { makeFakeAstro, type FakeAstro } from './fake-astro';
import { createHmac } from 'node:crypto';

const BIRTH = {
  birth_date: '1994-05-17',
  birth_time: '14:20',
  time_precision: 'exact',
  birth_place: { name: 'Москва', country: 'RU', lat: 55.7558, lon: 37.6173, tz: 'Europe/Moscow' },
  consent: { accepted: true, version: '2026-11-10' },
};

function initDataFor(user: Record<string, unknown> = FICTIONAL_USER): string {
  return signInitData({ botToken: TEST_BOT_TOKEN, user });
}

function svgOf(response: { text?: string; body?: unknown }): string {
  return response.text ?? String(response.body);
}

function wheelSig(wheelUrl: string): string {
  const url = new URL(wheelUrl, 'http://local');
  return url.searchParams.get('sig') ?? '';
}

let ctx: TestContext;
let fake: FakeAstro;

beforeAll(async () => {
  fake = makeFakeAstro();
  ctx = await createTestContext({ astro: fake });
});

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  await truncateAll(ctx.db);
});

describe('POST /api/v1/charts', () => {
  it('строит карту: 201, мини-разбор и подписанная ссылка на колесо', async () => {
    const response = await request(ctx.app.getHttpServer())
      .post('/api/v1/charts')
      .set(INIT_DATA_HEADER, initDataFor())
      .send(BIRTH)
      .expect(201);

    expect(response.body.chart.chart_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(response.body.chart.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(response.body.chart.planets.length).toBeGreaterThan(0);
    expect(response.body.chart.omitted_planets).toContain('chiron');
    expect(response.body.mini_reading.summary).toContain('Солнце');
    expect(response.body.mini_reading.sun).toContain('Телец');

    const sig = wheelSig(response.body.wheel_url);
    expect(sig).toMatch(/^\d+\.[A-Za-z0-9_-]+$/);

    const row = await ctx.db.queryOne<{ input_hash: string; user_id: string }>(
      `SELECT input_hash, user_id FROM charts`,
    );
    expect(row?.input_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(row?.user_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('идемпотентен: повтор того же входа даёт ту же карту', async () => {
    const first = await request(ctx.app.getHttpServer())
      .post('/api/v1/charts')
      .set(INIT_DATA_HEADER, initDataFor())
      .send(BIRTH)
      .expect(201);

    // Контракт 1.4.0: повтор того же входа — 200 и `is_restored: true`,
    // тот же конверт, что и на 201.
    const second = await request(ctx.app.getHttpServer())
      .post('/api/v1/charts')
      .set(INIT_DATA_HEADER, initDataFor())
      .send(BIRTH)
      .expect(200);

    expect(second.body.chart.chart_id).toBe(first.body.chart.chart_id);
    expect(first.body.is_restored).toBe(false);
    expect(second.body.is_restored).toBe(true);
    const rows = await ctx.db.query(`SELECT 1 FROM charts`);
    expect(rows.length).toBe(1);
  });

  it('warnings: пустой массив для точного времени и известного города', async () => {
    const created = await request(ctx.app.getHttpServer())
      .post('/api/v1/charts')
      .set(INIT_DATA_HEADER, initDataFor())
      .send(BIRTH)
      .expect(201);

    expect(created.body.warnings).toEqual([]);
  });

  it('warnings: unknown → no_birth_time, approximate → approximate_time', async () => {
    const unknownTime = await request(ctx.app.getHttpServer())
      .post('/api/v1/charts')
      .set(INIT_DATA_HEADER, initDataFor())
      .send({ ...BIRTH, birth_time: null, time_precision: 'unknown' })
      .expect(201);

    expect(unknownTime.body.warnings).toContain('no_birth_time');
    expect(unknownTime.body.warnings).not.toContain('approximate_time');

    // Другая дата: иначе тот же input_hash и ответ 200 (карта уже есть).
    const approximate = await request(ctx.app.getHttpServer())
      .post('/api/v1/charts')
      .set(INIT_DATA_HEADER, initDataFor())
      .send({ ...BIRTH, birth_date: '1990-01-02', time_precision: 'approximate' })
      .expect(201);

    expect(approximate.body.warnings).toContain('approximate_time');
  });

  it('warnings: город вне справочника → approximate_place', async () => {
    const created = await request(ctx.app.getHttpServer())
      .post('/api/v1/charts')
      .set(INIT_DATA_HEADER, initDataFor())
      .send({
        ...BIRTH,
        birth_place: {
          name: 'Нижние Котлы',
          country: 'RU',
          lat: 55.7,
          lon: 37.6,
          tz: 'Europe/Moscow',
        },
      })
      .expect(201);

    expect(created.body.warnings).toEqual(['approximate_place']);
  });

  it('warnings сохраняются: повторный GET отдаёт тот же список', async () => {
    const created = await request(ctx.app.getHttpServer())
      .post('/api/v1/charts')
      .set(INIT_DATA_HEADER, initDataFor())
      .send({ ...BIRTH, time_precision: 'approximate' })
      .expect(201);

    const fetched = await request(ctx.app.getHttpServer())
      .get(`/api/v1/charts/${created.body.chart.chart_id as string}`)
      .set(INIT_DATA_HEADER, initDataFor())
      .expect(200);

    expect(fetched.body.warnings).toEqual(created.body.warnings);
    expect(fetched.body.is_restored).toBe(true);
  });

  it('без initData → 401', async () => {
    await request(ctx.app.getHttpServer()).post('/api/v1/charts').send(BIRTH).expect(401);
  });

  it('несовершеннолетний → 422 VALIDATION_FAILED', async () => {
    const response = await request(ctx.app.getHttpServer())
      .post('/api/v1/charts')
      .set(INIT_DATA_HEADER, initDataFor())
      .send({ ...BIRTH, birth_date: new Date().getUTCFullYear() - 10 + '-01-01' })
      .expect(422);

    expect(response.body.code).toBe('VALIDATION_FAILED');
  });

  it('кривые координаты и страна → 422 VALIDATION_FAILED', async () => {
    await request(ctx.app.getHttpServer())
      .post('/api/v1/charts')
      .set(INIT_DATA_HEADER, initDataFor())
      .send({ ...BIRTH, birth_place: { ...BIRTH.birth_place, lat: 120 } })
      .expect(422);

    await request(ctx.app.getHttpServer())
      .post('/api/v1/charts')
      .set(INIT_DATA_HEADER, initDataFor())
      .send({ ...BIRTH, birth_place: { ...BIRTH.birth_place, country: 'RUS' } })
      .expect(422);
  });
});

describe('GET /api/v1/charts/current', () => {
  it('без карты → 404 NOT_FOUND (клиент уходит в онбординг)', async () => {
    const response = await request(ctx.app.getHttpServer())
      .get('/api/v1/charts/current')
      .set(INIT_DATA_HEADER, initDataFor())
      .expect(404);

    expect(response.body.code).toBe('NOT_FOUND');
  });

  it('возвращает последнюю карту и is_restored: true', async () => {
    await request(ctx.app.getHttpServer())
      .post('/api/v1/charts')
      .set(INIT_DATA_HEADER, initDataFor())
      .send(BIRTH)
      .expect(201);

    const response = await request(ctx.app.getHttpServer())
      .get('/api/v1/charts/current')
      .set(INIT_DATA_HEADER, initDataFor())
      .expect(200);

    expect(response.body.chart.chart_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(response.body.is_restored).toBe(true);
    expect(Array.isArray(response.body.warnings)).toBe(true);
    expect(response.body.wheel_url).toContain('/wheel.svg?sig=');
    expect(response.body.wheel_png_url).toContain('/wheel.png?sig=');
  });

  it('Me.chart_id указывает на последнюю карту (контракт 1.4.0)', async () => {
    const created = await request(ctx.app.getHttpServer())
      .post('/api/v1/charts')
      .set(INIT_DATA_HEADER, initDataFor())
      .send(BIRTH)
      .expect(201);

    const me = await request(ctx.app.getHttpServer())
      .get('/api/v1/me')
      .set(INIT_DATA_HEADER, initDataFor())
      .expect(200);

    expect(me.body.chart_id).toBe(created.body.chart.chart_id);
    expect(me.body.has_chart).toBe(true);
  });

  it('чужая карта не видна: у второго пользователя 404', async () => {
    await request(ctx.app.getHttpServer())
      .post('/api/v1/charts')
      .set(INIT_DATA_HEADER, initDataFor())
      .send(BIRTH)
      .expect(201);

    await request(ctx.app.getHttpServer())
      .get('/api/v1/charts/current')
      .set(INIT_DATA_HEADER, initDataFor({ id: 555000222, first_name: 'Второй' }))
      .expect(404);
  });
});

describe('GET /api/v1/charts/{id}', () => {
  it('возвращает карту владельцу и 404 чужому', async () => {
    const created = await request(ctx.app.getHttpServer())
      .post('/api/v1/charts')
      .set(INIT_DATA_HEADER, initDataFor())
      .send(BIRTH)
      .expect(201);

    const chartId = created.body.chart.chart_id as string;

    const own = await request(ctx.app.getHttpServer())
      .get(`/api/v1/charts/${chartId}`)
      .set(INIT_DATA_HEADER, initDataFor())
      .expect(200);
    expect(own.body.chart.chart_id).toBe(chartId);
    expect(own.body.mini_reading.summary).toContain('Солнце');
    expect(own.body.wheel_url).toContain('/wheel.svg?sig=');
    expect(own.body.wheel_png_url).toContain('/wheel.png?sig=');

    const stranger = await request(ctx.app.getHttpServer())
      .get(`/api/v1/charts/${chartId}`)
      .set(INIT_DATA_HEADER, initDataFor({ id: 555000111, first_name: 'Другой' }))
      .expect(404);
    expect(stranger.body.code).toBe('NOT_FOUND');
  });

  it('битый uuid → 422 VALIDATION_FAILED, а не 400', async () => {
    const response = await request(ctx.app.getHttpServer())
      .get('/api/v1/charts/not-a-uuid')
      .set(INIT_DATA_HEADER, initDataFor())
      .expect(422);

    expect(response.body.code).toBe('VALIDATION_FAILED');
  });
});

describe('GET /api/v1/charts/{id}/wheel.svg', () => {
  it('публичный: отдаёт SVG по подписи без initData', async () => {
    const created = await request(ctx.app.getHttpServer())
      .post('/api/v1/charts')
      .set(INIT_DATA_HEADER, initDataFor())
      .send(BIRTH)
      .expect(201);

    const wheelUrl = created.body.wheel_url as string;

    const response = await request(ctx.app.getHttpServer()).get(wheelUrl).expect(200);
    expect(response.headers['content-type']).toContain('image/svg+xml');
    expect(svgOf(response)).toContain('<svg');
    expect(svgOf(response)).toContain('data-theme="dark"');

    const light = await request(ctx.app.getHttpServer()).get(`${wheelUrl}&theme=light`).expect(200);
    expect(svgOf(light)).toContain('data-theme="light"');
  });

  it('без подписи и с чужой подписью → 403', async () => {
    const created = await request(ctx.app.getHttpServer())
      .post('/api/v1/charts')
      .set(INIT_DATA_HEADER, initDataFor())
      .send(BIRTH)
      .expect(201);

    const chartId = created.body.chart.chart_id as string;
    const sig = wheelSig(created.body.wheel_url);

    await request(ctx.app.getHttpServer()).get(`/api/v1/charts/${chartId}/wheel.svg`).expect(403);

    const forged = createHmac('sha256', TEST_PEPPER).update(`${chartId}:9999999999`).digest('base64url');
    const response = await request(ctx.app.getHttpServer())
      .get(`/api/v1/charts/${chartId}/wheel.svg?sig=9999999999.${forged}`)
      .expect(403);
    expect(response.body.code).toBe('FORBIDDEN');

    // Просроченная подпись того же вида.
    await request(ctx.app.getHttpServer())
      .get(`/api/v1/charts/${chartId}/wheel.svg?sig=1.${sig.split('.')[1]}`)
      .expect(403);
  });

  it('wheel.png отдаёт PNG без initData (по подписи)', async () => {
    const created = await request(ctx.app.getHttpServer())
      .post('/api/v1/charts')
      .set(INIT_DATA_HEADER, initDataFor())
      .send(BIRTH)
      .expect(201);

    const pngUrl = created.body.wheel_png_url as string;
    expect(pngUrl).toContain('/wheel.png?sig=');

    const response = await request(ctx.app.getHttpServer())
      .get(pngUrl)
      .buffer(true)
      .parse((res, done) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => done(null, Buffer.concat(chunks)));
      })
      .expect(200);

    expect(response.headers['content-type']).toBe('image/png');
    // PNG-сигнатура: 89 50 4E 47
    expect((response.body as Buffer).subarray(0, 4).toString('hex')).toBe('89504e47');
  });

  it('wheel.png: size=1600 даёт картинку шириной 1600 (контракт 1.4.0)', async () => {
    const created = await request(ctx.app.getHttpServer())
      .post('/api/v1/charts')
      .set(INIT_DATA_HEADER, initDataFor())
      .send(BIRTH)
      .expect(201);

    const pngUrl = `${created.body.wheel_png_url as string}&size=1600`;

    const response = await request(ctx.app.getHttpServer())
      .get(pngUrl)
      .buffer(true)
      .parse((res, done) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => done(null, Buffer.concat(chunks)));
      })
      .expect(200);

    const png = response.body as Buffer;
    expect(png.subarray(0, 4).toString('hex')).toBe('89504e47');
    // Ширина PNG лежит в IHDR: байты 16…19, big-endian.
    expect(png.readUInt32BE(16)).toBe(1600);
    expect(png.readUInt32BE(20)).toBe(1600);
  });

  it('wheel.png: size не 1080 и не 1600 → 422, без молчаливой подмены', async () => {
    const created = await request(ctx.app.getHttpServer())
      .post('/api/v1/charts')
      .set(INIT_DATA_HEADER, initDataFor())
      .send(BIRTH)
      .expect(201);

    const response = await request(ctx.app.getHttpServer())
      .get(`${created.body.wheel_png_url as string}&size=1300`)
      .expect(422);

    expect(response.body.code).toBe('VALIDATION_FAILED');
    expect(response.body.details.field_errors).toEqual([
      { field: 'size', message: expect.any(String) as string },
    ]);
  });

  it('wheel.png без подписи → 403', async () => {
    const created = await request(ctx.app.getHttpServer())
      .post('/api/v1/charts')
      .set(INIT_DATA_HEADER, initDataFor())
      .send(BIRTH)
      .expect(201);

    const chartId = created.body.chart.chart_id as string;
    await request(ctx.app.getHttpServer())
      .get(`/api/v1/charts/${chartId}/wheel.png`)
      .expect(403);
  });

  it('неизвестная тема → 422 VALIDATION_FAILED с field_errors', async () => {
    const created = await request(ctx.app.getHttpServer())
      .post('/api/v1/charts')
      .set(INIT_DATA_HEADER, initDataFor())
      .send(BIRTH)
      .expect(201);

    const wheelUrl = created.body.wheel_url as string;
    const response = await request(ctx.app.getHttpServer()).get(`${wheelUrl}&theme=neon`).expect(422);
    expect(response.body.code).toBe('VALIDATION_FAILED');
    expect(response.body.details.field_errors).toEqual([
      { field: 'theme', message: expect.any(String) as string },
    ]);
  });
});

describe('сайдкар недоступен', () => {
  let downCtx: TestContext;

  beforeAll(async () => {
    downCtx = await createTestContext({ astro: makeFakeAstro({ down: true }) });
  });

  afterAll(async () => {
    await downCtx.close();
  });

  it('POST /charts → 503 INTERNAL, приложение не падает', async () => {
    const response = await request(downCtx.app.getHttpServer())
      .post('/api/v1/charts')
      .set(INIT_DATA_HEADER, initDataFor())
      .send(BIRTH)
      .expect(503);

    expect(response.body).toMatchObject({ code: 'INTERNAL' });
    expect(typeof response.body.request_id).toBe('string');
  });

  it('/health → degraded и astro: down', async () => {
    const response = await request(downCtx.app.getHttpServer()).get('/api/v1/health').expect(200);

    expect(response.body).toMatchObject({ status: 'degraded', db: 'ok', astro: 'down' });
  });
});
