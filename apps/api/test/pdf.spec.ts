import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { INIT_DATA_HEADER } from '../src/modules/auth/init-data';
import { isPublicPath } from '../src/modules/auth/public-routes';
import { FileStorageService } from '../src/modules/files/file-storage.service';
import { createTestContext, truncateAll, type TestContext } from './test-app';
import { signInitData } from './init-data-fixture';
import { FICTIONAL_USER, TEST_BOT_TOKEN } from './test-env';
import { makeFakeAstro } from './fake-astro';

/**
 * PDF разбора (контракт 1.6.8, итерация 32).
 *
 * Проверяются обещания, которые нельзя увидеть глазами в браузере:
 *
 *   1. **`POST` отвечает `202` в любом случае**, а `Idempotency-Key`
 *      обязателен — двойной тап не ставит две сборки.
 *   2. **Повтор не пересобирает файл**: ключ кэша `(report_id,
 *      engine_version, prompt_version)`, второй `POST` отдаёт ту же строку.
 *   3. **Права**: чужой и неоплаченный разбор — `403 report_not_paid`, нет
 *      разбора — `404`, тизер/неготовый — `409 report_not_ready`.
 *   4. **Файл приватный**: без подписи `403`, с подделанной подписью `403`,
 *      с протухшей — `403 file_link_expired`; прямой путь хранилища наружу не
 *      отдаётся нигде.
 *   5. **Провал сборки не удаляет строку** и не запрещает повтор.
 *   6. **`DELETE /me` стирает файл с диска**, а не только строку в БД.
 */

const BIRTH = {
  birth_date: '1994-05-17',
  birth_time: '14:20',
  time_precision: 'exact',
  birth_place: { name: 'Москва', country: 'RU', lat: 55.7558, lon: 37.6173, tz: 'Europe/Moscow' },
  consent: { accepted: true, version: '2026-11-10' },
};

const SECTIONS = [
  { key: 'core', title: 'Ядро' },
  { key: 'emotions', title: 'Эмоции' },
  { key: 'talents', title: 'Таланты' },
  { key: 'relations', title: 'Отношения' },
  { key: 'money', title: 'Деньги' },
  { key: 'purpose', title: 'Предназначение' },
  { key: 'summary', title: 'Итог: что с этим делать' },
] as const;

function initDataFor(userId: number = FICTIONAL_USER.id): string {
  return signInitData({ botToken: TEST_BOT_TOKEN, user: { ...FICTIONAL_USER, id: userId } });
}

interface PdfStatusBody {
  readonly status: 'pending' | 'ready' | 'failed';
  readonly url?: string;
  readonly expires_at?: string;
  readonly error?: string;
}

let ctx: TestContext;
let storage: FileStorageService;
/** Флаги подмены сайдкара: мутируем, чтобы проверить провал сборки. */
const astroFlags: { down: boolean } = { down: false };

beforeAll(async () => {
  ctx = await createTestContext({
    astro: makeFakeAstro(astroFlags),
    env: { PUBLIC_API_URL: 'https://api.test' },
  });
  storage = ctx.app.get(FileStorageService);
});

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  await truncateAll(ctx.db);
  astroFlags.down = false;
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

/** Оплаченный разбор: право на карту + строка `reports` со всеми главами. */
async function paidReport(
  options: { readonly status?: string; readonly chapters?: unknown[] | null; readonly paid?: boolean } = {},
): Promise<{ userId: string; chartId: string; reportId: string }> {
  const { userId, chartId } = await userWithChart();

  if (options.paid !== false) {
    await ctx.db.query(
      `INSERT INTO entitlements (user_id, kind, status, chart_id)
       VALUES ($1, 'report', 'active', $2)`,
      [userId, chartId],
    );
  }

  const chapters =
    options.chapters === undefined
      ? SECTIONS.map((section, index) => ({
          key: section.key,
          title: section.title,
          order: index,
          body_md:
            `Первая мысль о разделе «${section.title}». Вторая мысль, тоже спокойная.\n\n` +
            'Второй абзац: что с этим делать дальше и почему это работает.',
        }))
      : options.chapters;

  const report = await ctx.db.queryOne<{ id: string }>(
    `INSERT INTO reports
       (chart_id, user_id, kind, status, prompt_version, report_structure_version, chapters)
     VALUES ($1, $2, 'report', $3::report_status, 'prompts_v1.4', 'structure_v1', $4::jsonb)
     RETURNING id`,
    [chartId, userId, options.status ?? 'ready', chapters === null ? null : JSON.stringify(chapters)],
  );

  return { userId, chartId, reportId: report?.id ?? '' };
}

function requestPdf(reportId: string, idemKey = 'pdf-key-1', userId?: number) {
  const builder = request(ctx.app.getHttpServer())
    .post(`/api/v1/reports/${reportId}/pdf`)
    .set(INIT_DATA_HEADER, initDataFor(userId));

  return idemKey === '' ? builder : builder.set('Idempotency-Key', idemKey);
}

function statusPdf(reportId: string, userId?: number) {
  return request(ctx.app.getHttpServer())
    .get(`/api/v1/reports/${reportId}/pdf`)
    .set(INIT_DATA_HEADER, initDataFor(userId));
}

/** Сборка идёт в фоне: ждём, пока статус перестанет быть `pending`. */
async function waitReady(reportId: string): Promise<PdfStatusBody> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const response = await statusPdf(reportId).expect(200);
    const body = response.body as PdfStatusBody;
    if (body.status !== 'pending') {
      return body;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  throw new Error(`PDF разбора ${reportId} так и остался pending`);
}

describe('POST /reports/{id}/pdf — форма и права', () => {
  it('без Idempotency-Key → 422 и ни одной строки сборки', async () => {
    const { reportId } = await paidReport();

    const response = await requestPdf(reportId, '').expect(422);

    expect(response.body.code).toBe('VALIDATION_FAILED');
    expect(response.body.details?.field_errors?.[0]?.field).toBe('Idempotency-Key');
    const rows = await ctx.db.query(`SELECT id FROM report_pdfs`);
    expect(rows).toHaveLength(0);
  });

  it('чужой разбор → 403 report_not_paid (не 404: заказ существует)', async () => {
    const { reportId } = await paidReport();

    const response = await requestPdf(reportId, 'pdf-key-1', 777_000_222).expect(403);

    expect(response.body.details?.reason).toBe('report_not_paid');
  });

  it('неоплаченный (тизер) разбор → 403 report_not_paid', async () => {
    const { reportId } = await paidReport({ paid: false });

    const response = await requestPdf(reportId).expect(403);

    expect(response.body.details?.reason).toBe('report_not_paid');
  });

  it('неизвестный разбор → 404 report_not_found', async () => {
    await userWithChart();

    const response = await requestPdf(randomUUID()).expect(404);

    expect(response.body.details?.reason).toBe('report_not_found');
  });

  it('разбор ещё собирается → 409 report_not_ready', async () => {
    const { reportId } = await paidReport({ status: 'writing' });

    const response = await requestPdf(reportId).expect(409);

    expect(response.body.details?.reason).toBe('report_not_ready');
  });

  it('готовый разбор без текста (пустые главы) → 409 report_not_ready', async () => {
    const { reportId } = await paidReport({ chapters: [] });

    const response = await requestPdf(reportId).expect(409);

    expect(response.body.details?.reason).toBe('report_not_ready');
  });
});

describe('POST /reports/{id}/pdf — 202, кэш и ссылка', () => {
  it('202 pending, затем ready со ссылкой; файл отдаётся по подписи', async () => {
    const { reportId } = await paidReport();

    const accepted = await requestPdf(reportId).expect(202);
    const acceptedBody = accepted.body as PdfStatusBody;
    // Первый ответ — либо `pending` (сборка в фоне), либо сразу `ready`.
    expect(['pending', 'ready']).toContain(acceptedBody.status);

    const ready = await waitReady(reportId);
    expect(ready.status).toBe('ready');
    expect(ready.expires_at).toBeDefined();
    expect(ready.url).toMatch(/^https:\/\/api\.test\/api\/v1\/files\/pdf\//u);
    // Прямых адресов хранилища в ответе нет — только наш домен и подпись.
    expect(ready.url).not.toContain(storage.directory);

    const url = new URL(ready.url ?? '');
    const downloaded = await request(ctx.app.getHttpServer())
      .get(`${url.pathname}${url.search}`)
      .expect(200);

    expect(downloaded.headers['content-type']).toContain('application/pdf');
    expect(downloaded.headers['cache-control']).toBe('private, no-store');
    const bytes = downloaded.body as Buffer;
    expect(bytes.subarray(0, 5).toString('utf8')).toBe('%PDF-');

    const row = await ctx.db.queryOne<{ downloads: number; pages: number | null }>(
      `SELECT downloads, pages FROM report_pdfs WHERE report_id = $1`,
      [reportId],
    );
    expect(row?.pages).toBeGreaterThan(0);
  });

  it('счётчик скачиваний растёт: метрика `pdf_downloaded_24h` не врёт', async () => {
    const { reportId } = await paidReport();
    await requestPdf(reportId).expect(202);
    const ready = await waitReady(reportId);
    const url = new URL(ready.url ?? '');

    await request(ctx.app.getHttpServer()).get(`${url.pathname}${url.search}`).expect(200);
    await request(ctx.app.getHttpServer()).get(`${url.pathname}${url.search}`).expect(200);

    // Счётчик пишется в фоне (`void`), поэтому ждём событие, а не строку.
    let downloads = 0;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const row = await ctx.db.queryOne<{ downloads: number }>(
        `SELECT downloads FROM report_pdfs WHERE report_id = $1`,
        [reportId],
      );
      downloads = row?.downloads ?? 0;
      if (downloads >= 2) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    expect(downloads).toBeGreaterThanOrEqual(2);
  });

  it('повторный POST не пересобирает файл: та же строка и тот же ключ', async () => {
    const { reportId } = await paidReport();

    await requestPdf(reportId, 'pdf-key-a').expect(202);
    const ready = await waitReady(reportId);
    const first = await ctx.db.queryOne<{ id: string; storage_key: string }>(
      `SELECT id, storage_key FROM report_pdfs WHERE report_id = $1`,
      [reportId],
    );

    const second = await requestPdf(reportId, 'pdf-key-b').expect(202);
    const secondBody = second.body as PdfStatusBody;

    expect(secondBody.status).toBe('ready');
    // Тот же файл: путь совпадает, отличается только подпись (у неё свой срок).
    expect(new URL(secondBody.url ?? '').pathname).toBe(new URL(ready.url ?? '').pathname);

    const again = await ctx.db.queryOne<{ id: string; storage_key: string }>(
      `SELECT id, storage_key FROM report_pdfs WHERE report_id = $1`,
      [reportId],
    );
    expect(again?.id).toBe(first?.id);
    expect(again?.storage_key).toBe(first?.storage_key);

    const rows = await ctx.db.query(`SELECT id FROM report_pdfs`);
    expect(rows).toHaveLength(1);
  });

  it('`GET /reports/{id}` отдаёт `pdf_url` только после сборки', async () => {
    const { reportId } = await paidReport();

    const before = await request(ctx.app.getHttpServer())
      .get(`/api/v1/reports/${reportId}`)
      .set(INIT_DATA_HEADER, initDataFor())
      .expect(200);
    expect(before.body.pdf_url).toBeNull();

    await requestPdf(reportId).expect(202);
    await waitReady(reportId);

    const after = await request(ctx.app.getHttpServer())
      .get(`/api/v1/reports/${reportId}`)
      .set(INIT_DATA_HEADER, initDataFor())
      .expect(200);

    // Ссылка абсолютная (задан `PUBLIC_API_URL`) и подписанная, а не путь
    // хранилища: `Report.pdf_url` — единственное место, где документ виден
    // снаружи, и он обязан быть нашим доменом.
    expect(after.body.pdf_url).toMatch(/^https:\/\/api\.test\/api\/v1\/files\/pdf\/.+\?sig=/u);
  });

  it('GET выдаёт свежую подпись каждый раз, но тот же файл', async () => {
    const { reportId } = await paidReport();
    await requestPdf(reportId).expect(202);
    await waitReady(reportId);

    const first = (await statusPdf(reportId).expect(200)).body as PdfStatusBody;
    const second = (await statusPdf(reportId).expect(200)).body as PdfStatusBody;

    const keyOf = (url: string | undefined): string => new URL(url ?? '').pathname;
    expect(keyOf(first.url)).toBe(keyOf(second.url));
  });
});

describe('GET /files — приватность файла', () => {
  it('без подписи → 403 file_signature_invalid', async () => {
    const { reportId } = await paidReport();
    await requestPdf(reportId).expect(202);
    await waitReady(reportId);

    const row = await ctx.db.queryOne<{ storage_key: string }>(
      `SELECT storage_key FROM report_pdfs WHERE report_id = $1`,
      [reportId],
    );

    const response = await request(ctx.app.getHttpServer())
      .get(`/api/v1/files/${row?.storage_key ?? ''}`)
      .expect(403);

    expect(response.body.details?.reason).toBe('file_signature_invalid');
  });

  it('подделанная подпись → 403, протухшая → 403 file_link_expired', async () => {
    const { reportId } = await paidReport();
    await requestPdf(reportId).expect(202);
    await waitReady(reportId);

    const row = await ctx.db.queryOne<{ storage_key: string }>(
      `SELECT storage_key FROM report_pdfs WHERE report_id = $1`,
      [reportId],
    );
    const key = row?.storage_key ?? '';

    const forged = await request(ctx.app.getHttpServer())
      .get(`/api/v1/files/${key}?sig=99999999999.подделка`)
      .expect(403);
    expect(forged.body.details?.reason).toBe('file_signature_invalid');

    // Отрицательный TTL — та же подпись, но срок уже вышел.
    const expired = storage.signedUrl(key, -60);
    const expiredUrl = new URL(expired.url);
    const expiredResponse = await request(ctx.app.getHttpServer())
      .get(`${expiredUrl.pathname}${expiredUrl.search}`)
      .expect(403);

    expect(expiredResponse.body.details?.reason).toBe('file_link_expired');
  });

  it('выход из каталога → 404, а не чтение файлов', async () => {
    const response = await request(ctx.app.getHttpServer())
      .get('/api/v1/files/pdf/..%2F..%2Fetc%2Fpasswd')
      .expect(404);

    expect(response.body.details?.reason).toBe('file_not_found');
  });

  it('чужой скоуп не публичный: до обработчика не доходит', () => {
    // Список публичных путей закрытый — только `pdf` и `card`. Это защита в
    // глубину: даже если обработчик когда-нибудь ослабнет, чужой скоуп не
    // станет доступен без initData.
    expect(isPublicPath('/api/v1/files/secret/a.pdf')).toBe(false);
    expect(isPublicPath('/api/v1/files/pdf/aaaaaaaa-0000-0000-0000-000000000000.pdf')).toBe(true);
  });
});

describe('провал сборки и повтор', () => {
  it('сайдкар лежит: строка остаётся failed, повтор разрешён и доходит до ready', async () => {
    const { reportId } = await paidReport();
    astroFlags.down = true;

    await requestPdf(reportId, 'pdf-key-fail').expect(202);
    const failed = await waitReady(reportId);

    expect(failed.status).toBe('failed');
    expect(failed.error).toBe('astro_unavailable');

    // `failed` — история попытки, а не удалённая строка.
    const rows = await ctx.db.query<{ status: string }>(`SELECT status FROM report_pdfs`);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('failed');

    astroFlags.down = false;
    const retried = await requestPdf(reportId, 'pdf-key-retry').expect(202);
    expect(['pending', 'ready']).toContain((retried.body as PdfStatusBody).status);

    const ready = await waitReady(reportId);
    expect(ready.status).toBe('ready');
    expect(ready.url).toBeDefined();
  });
});

describe('DELETE /me — файл удаляется вместе с аккаунтом', () => {
  it('PDF исчезает с диска, а не только строка из БД', async () => {
    const { reportId } = await paidReport();
    await requestPdf(reportId).expect(202);
    await waitReady(reportId);

    const row = await ctx.db.queryOne<{ storage_key: string }>(
      `SELECT storage_key FROM report_pdfs WHERE report_id = $1`,
      [reportId],
    );
    const key = row?.storage_key ?? '';
    expect(await storage.read(key)).not.toBeNull();

    await request(ctx.app.getHttpServer())
      .delete('/api/v1/me')
      .set(INIT_DATA_HEADER, initDataFor())
      .expect(204);

    // Файл стирается после коммита, но в том же обработчике: `DELETE /me`
    // не отвечает, пока файл не убран.
    expect(await storage.read(key)).toBeNull();
    const left = await ctx.db.query(`SELECT id FROM report_pdfs`);
    expect(left).toHaveLength(0);
  });
});
