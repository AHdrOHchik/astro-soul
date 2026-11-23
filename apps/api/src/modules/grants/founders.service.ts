import { Inject, Injectable } from '@nestjs/common';
import { ApiError, reasonOptions } from '../../common/api-error';
import { JsonLogger } from '../../common/logger';
import { DbService } from '../../db/db.service';
import { GrantsService } from './grants.service';

/**
 * Акция «первые 50» (итерация 39, контракт 1.6.14).
 *
 * Место выдаётся **на сервере** и атомарно: счётчик в приложении, «кто первый
 * нажал», не годится — два человека одновременно увидели бы «место 50» и оба
 * получили подарок. Ровно поэтому `INSERT … SELECT … HAVING count(*) < 50` под
 * advisory-локом, а номер места дополнительно уникален в схеме.
 *
 * Что получает основатель:
 *   • `single_report` — один полный разбор бесплатно (расходуется при первом
 *     заказе разбора);
 *   • `all_access` на 14 дней — чтобы успеть попробовать всё;
 *   • постоянную цену `founder_month` (250 ⭐ вместо 399) — не грант, а строка
 *     в `plans` с `is_active = false`, к которой сервер пускает только
 *     основателя.
 *
 * 51-му отвечаем `409 founders_exhausted` — и это не «нет мест, но попробуй
 * позже»: акция конечна по определению.
 */
export const FOUNDERS_TOTAL = 50;

/** Дней «всё включено» в подарок основателю. */
export const FOUNDER_ALL_ACCESS_DAYS = 14;

/** Advisory-лок акции: он же защищает от гонки за последнее место. */
const FOUNDERS_LOCK_ID = 39_050_001;

export interface FounderClaim {
  readonly place: number;
  /** `true` — человек уже был в списке, повторный вызов ничего не выдал. */
  readonly already: boolean;
}

@Injectable()
export class FoundersService {
  constructor(
    @Inject(DbService) private readonly db: DbService,
    @Inject(GrantsService) private readonly grants: GrantsService,
    @Inject(JsonLogger) private readonly logger: JsonLogger,
  ) {}

  /** Публичный счётчик для `GET /founders/count`: без мест и без ПДн. */
  async count(): Promise<{ taken: number; total: number }> {
    const row = await this.db.queryOne<{ taken: number }>(
      `SELECT count(*)::int AS taken FROM founders`,
      [],
    );

    return { taken: row?.taken ?? 0, total: FOUNDERS_TOTAL };
  }

  async placeOf(userId: string): Promise<number | null> {
    const row = await this.db.queryOne<{ place: number }>(
      `SELECT place FROM founders WHERE user_id = $1`,
      [userId],
    );

    return row?.place ?? null;
  }

  async isFounder(userId: string): Promise<boolean> {
    return (await this.placeOf(userId)) !== null;
  }

  /**
   * Занять место. Идемпотентно: повторный вызов возвращает то же место и не
   * выдаёт вторые права — иначе перезапуск приложения после сбоя сети
   * означал бы «подарок за каждый тап».
   */
  async claim(userId: string): Promise<FounderClaim> {
    const existing = await this.placeOf(userId);

    if (existing !== null) {
      return { place: existing, already: true };
    }

    const place = await this.db.withTransaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock($1)', [FOUNDERS_LOCK_ID]);

      const inserted = await client.query<{ place: number }>(
        `INSERT INTO founders (user_id, place)
         SELECT $1, COALESCE(MAX(place), 0) + 1
           FROM founders
         HAVING count(*) < $2
         RETURNING place`,
        [userId, FOUNDERS_TOTAL],
      );

      const row = inserted.rows[0];

      if (row === undefined) {
        throw new ApiError('CONFLICT', 409, {
          ...reasonOptions('founders_exhausted', `Все ${String(FOUNDERS_TOTAL)} мест основателей заняты`),
        });
      }

      return row.place;
    });

    // Права выдаются после фиксации места: если бюджет исчерпан, место уже
    // занято (человек — основатель), но права не выданы, и это честнее, чем
    // «место пропало, потому что бюджет кончился».
    try {
      await this.grants.issue({
        userId,
        kind: 'single_report',
        source: 'founder',
        checkBudget: true,
      });
      await this.grants.issue({
        userId,
        kind: 'all_access',
        source: 'founder',
        days: FOUNDER_ALL_ACCESS_DAYS,
        checkBudget: true,
      });
    } catch (error) {
      // Компенсация: место возвращается в список, если права не выданы.
      // Основатель без обещанного подарка — это не «основатель», а человек, у
      // которого молча забрали место; а «место занято, прав нет» не
      // исправляется ничем: повторный `claim` вернул бы `already`.
      await this.db.query('DELETE FROM founders WHERE user_id = $1', [userId]);

      this.logger.warn('founder_grant_failed', {
        user: userId,
        place,
        reason: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }

    this.logger.info('founder_claimed', { user: userId, place });

    return { place, already: false };
  }
}
