import { Inject, Injectable } from '@nestjs/common';
import { DbService } from '../../db/db.service';
import type { AstroChartData } from '../astro/astro.client';

export type PdfStatus = 'pending' | 'ready' | 'failed';

export interface PdfRow {
  readonly id: string;
  readonly report_id: string;
  readonly user_id: string;
  readonly engine_version: string;
  readonly prompt_version: string;
  readonly status: PdfStatus;
  readonly storage_key: string | null;
  readonly bytes: number | null;
  readonly pages: number | null;
  readonly build_ms: number | null;
  readonly downloads: number;
  readonly error_code: string | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

const COLUMNS = `id, report_id, user_id, engine_version, prompt_version, status,
  storage_key, bytes, pages, build_ms, downloads, error_code, created_at, updated_at`;

/**
 * Строки `report_pdfs` — кэш сборки и счётчики.
 *
 * Ключ кэша — `(report_id, engine_version, prompt_version)`: тот же разбор,
 * собранный другим движком или другой версией промпта, — это **другой**
 * документ, и подменять его старым файлом нельзя.
 */
@Injectable()
export class PdfRepository {
  constructor(@Inject(DbService) private readonly db: DbService) {}

  async find(
    reportId: string,
    engineVersion: string,
    promptVersion: string,
  ): Promise<PdfRow | null> {
    return this.db.queryOne<PdfRow>(
      `SELECT ${COLUMNS} FROM report_pdfs
        WHERE report_id = $1 AND engine_version = $2 AND prompt_version = $3`,
      [reportId, engineVersion, promptVersion],
    );
  }

  /**
   * Занимает слот сборки. `on conflict do nothing` — это и есть защита от
   * двойной сборки: два одновременных `POST` не запускают два процесса над
   * одним разбором (и не пишут друг другу по ногам).
   */
  async claim(
    reportId: string,
    userId: string,
    engineVersion: string,
    promptVersion: string,
  ): Promise<{ row: PdfRow; created: boolean }> {
    const inserted = await this.db.queryOne<PdfRow>(
      `INSERT INTO report_pdfs (report_id, user_id, engine_version, prompt_version, status)
       VALUES ($1, $2, $3, $4, 'pending')
       ON CONFLICT (report_id, engine_version, prompt_version) DO NOTHING
       RETURNING ${COLUMNS}`,
      [reportId, userId, engineVersion, promptVersion],
    );

    if (inserted !== null) {
      return { row: inserted, created: true };
    }

    const existing = await this.find(reportId, engineVersion, promptVersion);
    if (existing === null) {
      throw new Error('pdf_claim_race');
    }

    return { row: existing, created: false };
  }

  /** Повтор после провала: строка возвращается в `pending`, файла ещё нет. */
  async retry(id: string): Promise<PdfRow | null> {
    return this.db.queryOne<PdfRow>(
      `UPDATE report_pdfs
          SET status = 'pending', error_code = NULL, updated_at = now()
        WHERE id = $1
        RETURNING ${COLUMNS}`,
      [id],
    );
  }

  async markReady(
    id: string,
    ready: { storageKey: string; bytes: number; pages: number; buildMs: number },
  ): Promise<void> {
    await this.db.query(
      `UPDATE report_pdfs
          SET status = 'ready', storage_key = $2, bytes = $3, pages = $4,
              build_ms = $5, error_code = NULL, updated_at = now()
        WHERE id = $1`,
      [id, ready.storageKey, ready.bytes, ready.pages, ready.buildMs],
    );
  }

  async markFailed(id: string, code: string): Promise<void> {
    await this.db.query(
      `UPDATE report_pdfs
          SET status = 'failed', error_code = $2, updated_at = now()
        WHERE id = $1`,
      [id, code],
    );
  }

  /** Счётчик скачиваний по ключу файла (вызывается из `GET /files/{key}`). */
  async markDownloaded(storageKey: string): Promise<void> {
    await this.db.query(
      `UPDATE report_pdfs SET downloads = downloads + 1 WHERE storage_key = $1`,
      [storageKey],
    );
  }

  /** Ключи файлов человека — для `DELETE /me`: файлы удаляются с диска. */
  async keysForUser(userId: string): Promise<string[]> {
    const rows = await this.db.query<{ storage_key: string }>(
      `SELECT storage_key FROM report_pdfs
        WHERE user_id = $1 AND storage_key IS NOT NULL`,
      [userId],
    );

    return rows.map((row) => row.storage_key);
  }

  /** Данные карты для колеса: только то, что нужно рендеру. */
  async chartData(chartId: string): Promise<AstroChartData | null> {
    const row = await this.db.queryOne<{ data: AstroChartData }>(
      `SELECT data FROM charts WHERE id = $1`,
      [chartId],
    );

    return row?.data ?? null;
  }
}
