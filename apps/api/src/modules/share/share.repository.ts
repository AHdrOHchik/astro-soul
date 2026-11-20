import { Inject, Injectable } from '@nestjs/common';
import { DbService } from '../../db/db.service';

export type ShareCardKind = 'day' | 'wheel' | 'insight';

export interface ShareCardRow {
  readonly id: string;
  readonly kind: ShareCardKind;
  readonly content_hash: string;
  readonly short_id: string;
  readonly storage_key: string;
  readonly bytes: number;
  readonly width: number;
  readonly height: number;
  readonly created_at: Date;
}

export interface ShareCardInput {
  readonly kind: ShareCardKind;
  readonly contentHash: string;
  readonly shortId: string;
  readonly storageKey: string;
  readonly bytes: number;
  readonly width: number;
  readonly height: number;
}

const COLUMNS = `id, kind, content_hash, short_id, storage_key, bytes, width, height, created_at`;

/**
 * Кэш карточек по содержимому.
 *
 * Ключ — `(kind, content_hash)`, а не `user_id`: карточка не принадлежит
 * человеку. Это и есть смысл кэша — «один и тот же день не генерируется сотне
 * людей» — и одновременно защита приватности: в схеме нет связи между
 * карточкой и тем, кто её попросил.
 */
@Injectable()
export class ShareRepository {
  constructor(@Inject(DbService) private readonly db: DbService) {}

  async find(kind: ShareCardKind, contentHash: string): Promise<ShareCardRow | null> {
    return this.db.queryOne<ShareCardRow>(
      `SELECT ${COLUMNS} FROM share_cards WHERE kind = $1 AND content_hash = $2`,
      [kind, contentHash],
    );
  }

  async findByShortId(shortId: string): Promise<ShareCardRow | null> {
    return this.db.queryOne<ShareCardRow>(
      `SELECT ${COLUMNS} FROM share_cards WHERE short_id = $1`,
      [shortId],
    );
  }

  /** Карточка по её `short_id` (ссылка `t.me/<bot>?start=sh_<short_id>`). */
  async resolveShortId(shortId: string): Promise<ShareCardRow | null> {
    return this.findByShortId(shortId);
  }

  /**
   * Сегодняшний прогноз человека — источник строки «сегодня хорошо для…».
   *
   * Берём последнюю строку по местной дате: если прогноза на сегодня ещё нет
   * (человек без подписки), вернётся `null`, и карточка соберётся из фактов
   * сайдкара без этой строки.
   */
  async latestForecast(
    userId: string,
    promptVersion: string,
  ): Promise<{ facts: unknown; body_md: string | null } | null> {
    return this.db.queryOne<{ facts: unknown; body_md: string | null }>(
      `SELECT facts, body_md FROM daily_forecasts
        WHERE user_id = $1 AND prompt_version = $2 AND status = 'ready'
        ORDER BY local_date DESC
        LIMIT 1`,
      [userId, promptVersion],
    );
  }

  /** Карта человека для карточек: последняя построенная. */
  async currentChart(userId: string): Promise<{ id: string; data: unknown } | null> {
    return this.db.queryOne<{ id: string; data: unknown }>(
      `SELECT id, data FROM charts WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [userId],
    );
  }

  /**
   * Последний **готовый** разбор человека — источник цитаты для `insight`.
   *
   * Именно `ready`: тизер до оплаты цитировать нельзя, а `failed` не содержит
   * текста вовсе. Право на цитату — это и есть оплаченный разбор.
   */
  async latestReadyReport(
    userId: string,
  ): Promise<{ id: string; chapters: readonly { key: string; body_md: string }[] } | null> {
    return this.db.queryOne<{
      id: string;
      chapters: readonly { key: string; body_md: string }[];
    }>(
      `SELECT id, chapters FROM reports
        WHERE user_id = $1 AND kind = 'report' AND status = 'ready' AND chapters IS NOT NULL
        ORDER BY created_at DESC
        LIMIT 1`,
      [userId],
    );
  }

  /**
   * Вставляет карточку. `on conflict do nothing` — гонка двух одновременных
   * запросов: оба увидят один и тот же файл, второй ничего не перезапишет.
   */
  async insert(input: ShareCardInput): Promise<ShareCardRow | null> {
    return this.db.queryOne<ShareCardRow>(
      `INSERT INTO share_cards (kind, content_hash, short_id, storage_key, bytes, width, height)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT DO NOTHING
       RETURNING ${COLUMNS}`,
      [
        input.kind,
        input.contentHash,
        input.shortId,
        input.storageKey,
        input.bytes,
        input.width,
        input.height,
      ],
    );
  }
}
