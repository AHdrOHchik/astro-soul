import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { INIT_DATA_HEADER } from '../src/modules/auth/init-data';
import { createTestContext, truncateAll, type TestContext } from './test-app';
import { signInitData } from './init-data-fixture';
import { FICTIONAL_USER, TEST_BOT_TOKEN, TEST_PEPPER } from './test-env';
import { makeFakeAstro } from './fake-astro';
import { userIdFromTelegramId } from '../src/modules/users/pseudonym';
import { ANALYTICS_EVENTS } from '../src/modules/events/events.dto';

let ctx: TestContext;

function initData(): string {
  return signInitData({ botToken: TEST_BOT_TOKEN, user: FICTIONAL_USER });
}

function event(name: string, props?: Record<string, string | number | boolean>) {
  return { name, occurred_at: new Date().toISOString(), ...(props === undefined ? {} : { props }) };
}

beforeAll(async () => {
  ctx = await createTestContext({ astro: makeFakeAstro() });
});

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  await truncateAll(ctx.db);
});

describe('POST /api/v1/events', () => {
  it('принимает батч и отвечает 202', async () => {
    const response = await request(ctx.app.getHttpServer())
      .post('/api/v1/events')
      .set(INIT_DATA_HEADER, initData())
      .send({ events: [event('app_open'), event('consent_view', { step: 'consent' })] })
      .expect(202);

    expect(response.body).toEqual({ accepted: 2 });

    const rows = await ctx.db.query<{ name: string; occurred_at: Date | null }>(
      'SELECT name, occurred_at FROM events ORDER BY id',
    );
    expect(rows.map((row) => row.name)).toEqual(['app_open', 'consent_view']);
    expect(rows.every((row) => row.occurred_at !== null)).toBe(true);
  });

  it('пишет события на пользователя', async () => {
    await request(ctx.app.getHttpServer())
      .post('/api/v1/events')
      .set(INIT_DATA_HEADER, initData())
      .send({ events: [event('chart_requested')] })
      .expect(202);

    const userId = userIdFromTelegramId(BigInt(FICTIONAL_USER.id), TEST_PEPPER);
    const rows = await ctx.db.query<{ user_id: string }>('SELECT user_id FROM events');
    expect(rows[0]?.user_id).toBe(userId);
  });

  it('21 событие → 422 и ничего не записано', async () => {
    const events = Array.from({ length: 21 }, () => event('app_open'));

    const response = await request(ctx.app.getHttpServer())
      .post('/api/v1/events')
      .set(INIT_DATA_HEADER, initData())
      .send({ events })
      .expect(422);

    expect(response.body.code).toBe('VALIDATION_FAILED');
    expect(response.body.details.field_errors[0].field).toBe('events');

    const rows = await ctx.db.query('SELECT 1 FROM events');
    expect(rows).toHaveLength(0);
  });

  it('неизвестное имя события → 422 с полем events.name', async () => {
    const response = await request(ctx.app.getHttpServer())
      .post('/api/v1/events')
      .set(INIT_DATA_HEADER, initData())
      .send({ events: [event('made_up_event')] })
      .expect(422);

    expect(response.body.details.field_errors).toEqual([
      { field: 'events.name', message: 'Такого события нет в контракте' },
    ]);
  });

  it('событие с ПДн в props отбрасывается, остальное принимается', async () => {
    const response = await request(ctx.app.getHttpServer())
      .post('/api/v1/events')
      .set(INIT_DATA_HEADER, initData())
      .send({
        events: [
          event('birth_date_done', { birth_date: '1994-05-17' }),
          event('consent_accepted', { step: 'consent' }),
        ],
      })
      .expect(202);

    expect(response.body).toEqual({ accepted: 1 });
    const rows = await ctx.db.query<{ name: string; props: unknown }>('SELECT name, props FROM events');
    expect(rows.map((row) => row.name)).toEqual(['consent_accepted']);
    expect(JSON.stringify(rows[0]?.props)).not.toContain('1994-05-17');
  });

  it('время старше суток отбрасывается; батч только из таких — 422', async () => {
    const stale = {
      name: 'app_open',
      occurred_at: new Date(Date.now() - 3 * 24 * 60 * 60_000).toISOString(),
    };

    await request(ctx.app.getHttpServer())
      .post('/api/v1/events')
      .set(INIT_DATA_HEADER, initData())
      .send({ events: [stale, event('consent_view')] })
      .expect(202);

    const rows = await ctx.db.query<{ name: string }>('SELECT name FROM events');
    expect(rows.map((row) => row.name)).toEqual(['consent_view']);

    const response = await request(ctx.app.getHttpServer())
      .post('/api/v1/events')
      .set(INIT_DATA_HEADER, initData())
      .send({ events: [stale] })
      .expect(422);
    expect(response.body.details.field_errors[0].field).toBe('events.occurred_at');
  });

  it('без initData → 401', async () => {
    await request(ctx.app.getHttpServer())
      .post('/api/v1/events')
      .send({ events: [event('app_open')] })
      .expect(401);
  });

  it('список событий в коде совпадает с контрактом 1.6.12: 39 штук без дублей', () => {
    expect(ANALYTICS_EVENTS).toHaveLength(39);
    expect(new Set(ANALYTICS_EVENTS).size).toBe(39);
    // QA: `validation_failed_client` теперь в контракте, и сервер его принимает.
    expect(ANALYTICS_EVENTS).toContain('validation_failed_client');
    // 1.6.9: `share_sent` — клиентское событие («человек отправил»), а
    // `share_card_created` и `share_card_opened` — серверные. Два набора не
    // пересекаются: одно имя в двух наборах гарантирует путаницу в отчётах.
    expect(ANALYTICS_EVENTS).toContain('share_sent');
    expect(ANALYTICS_EVENTS).not.toContain('share_card_opened');
    expect(ANALYTICS_EVENTS).not.toContain('share_card_created');
  });

  it('`share_sent` от клиента принимается: 202 и запись с `kind`/`channel`', async () => {
    const response = await request(ctx.app.getHttpServer())
      .post('/api/v1/events')
      .set(INIT_DATA_HEADER, initData())
      .send({ events: [event('share_sent', { kind: 'day', channel: 'inline' })] })
      .expect(202);

    expect(response.body).toEqual({ accepted: 1 });

    const rows = await ctx.db.query<{ name: string; props: Record<string, unknown> }>(
      'SELECT name, props FROM events',
    );
    expect(rows.map((row) => row.name)).toEqual(['share_sent']);
    expect(rows[0]?.props).toEqual({ kind: 'day', channel: 'inline' });
  });

  it('`share_sent` с `kind: "compat"` → 422: такой карточки не существует', async () => {
    const response = await request(ctx.app.getHttpServer())
      .post('/api/v1/events')
      .set(INIT_DATA_HEADER, initData())
      .send({ events: [event('share_sent', { kind: 'compat', channel: 'inline' })] })
      .expect(422);

    expect(response.body.code).toBe('VALIDATION_FAILED');
    expect(response.body.details.field_errors).toEqual([
      { field: 'events.props.kind', message: 'Вид карточки — day, wheel, insight, identity или moon' },
    ]);

    const rows = await ctx.db.query('SELECT 1 FROM events');
    expect(rows).toHaveLength(0);
  });

  it('`share_sent` без свойств → 422, а лишние свойства вырезаются', async () => {
    const missing = await request(ctx.app.getHttpServer())
      .post('/api/v1/events')
      .set(INIT_DATA_HEADER, initData())
      .send({ events: [event('share_sent')] })
      .expect(422);

    const missingFields = (missing.body as { details: { field_errors: { field: string }[] } }).details
      .field_errors.map((error) => error.field);
    expect(missingFields).toEqual(['events.props.kind', 'events.props.channel']);

    // Лишнее поле в `props` — не ошибка: контракт знает про `kind`/`channel`,
    // остальное в БД не попадает. Так «на всякий случай» присланная ссылка на
    // файл не осядет в аналитике.
    await request(ctx.app.getHttpServer())
      .post('/api/v1/events')
      .set(INIT_DATA_HEADER, initData())
      .send({
        events: [
          event('share_sent', { kind: 'wheel', channel: 'link', url: 'https://api.test/files/x?sig=1' }),
        ],
      })
      .expect(202);

    const rows = await ctx.db.query<{ props: Record<string, unknown> }>(
      "SELECT props FROM events WHERE name = 'share_sent'",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.props).toEqual({ kind: 'wheel', channel: 'link' });
  });

  it('неизвестный канал отправки → 422: свободные свойства у `share_sent` не проходят', async () => {
    const response = await request(ctx.app.getHttpServer())
      .post('/api/v1/events')
      .set(INIT_DATA_HEADER, initData())
      .send({ events: [event('share_sent', { kind: 'day', channel: 'telegram' })] })
      .expect(422);

    expect(response.body.details.field_errors).toEqual([
      { field: 'events.props.channel', message: 'Канал отправки — inline или link' },
    ]);
  });

  it('validation_failed_client принимается, а серверное событие — нет', async () => {
    await request(ctx.app.getHttpServer())
      .post('/api/v1/events')
      .set(INIT_DATA_HEADER, initData())
      .send({ events: [event('validation_failed_client', { field: 'birth_date' })] })
      .expect(202);

    const names = await ctx.db.query<{ name: string }>('SELECT name FROM events');
    expect(names.map((row) => row.name)).toEqual(['validation_failed_client']);

    // `payment_rejected` пишет только сервер: клиентский батч с ним — 422.
    const rejected = await request(ctx.app.getHttpServer())
      .post('/api/v1/events')
      .set(INIT_DATA_HEADER, initData())
      .send({ events: [event('payment_rejected')] })
      .expect(422);
    expect(rejected.body.details.field_errors[0].field).toBe('events.name');
  });
});
