import { Inject, Injectable } from '@nestjs/common';
import { DbService } from '../../db/db.service';

export type QuestionStatus = 'pending' | 'ready' | 'failed' | 'refused';

export interface QuestionRow {
  readonly id: string;
  readonly local_date: string;
  readonly timezone: string;
  readonly question: string;
  readonly question_hash: string;
  readonly question_len: number;
  readonly topic: string;
  readonly status: QuestionStatus;
  readonly reason: string | null;
  readonly body_md: string | null;
  readonly chars: number | null;
  readonly warnings: readonly string[];
  readonly cost_rub: string;
  readonly duration_ms: number | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

export interface InsertQuestionInput {
  readonly userId: string;
  readonly localDate: string;
  readonly timezone: string;
  readonly question: string;
  readonly questionHash: string;
  readonly topic: string;
  readonly idemKey: string;
  readonly engineVersion: string;
  readonly promptVersion: string;
}

const COLUMNS = `id, local_date::text AS local_date, timezone, question, question_hash, question_len,
                 topic, status, reason, body_md, chars, warnings,
                 cost_rub::text AS cost_rub, duration_ms, created_at, updated_at`;

/**
 * Исход вставки:
 *   • `created` — новая строка, вызывающий генерирует;
 *   • `duplicate` — тот же `Idempotency-Key`, отдаём существующую (второго
 *     вызова модели нет);
 *   • `in_progress` — уже есть `pending` вопрос, `409`.
 */
export type InsertOutcome =
  | { readonly kind: 'created'; readonly row: QuestionRow }
  | { readonly kind: 'duplicate'; readonly row: QuestionRow }
  | { readonly kind: 'in_progress' };

@Injectable()
export class QuestionsRepository {
  constructor(@Inject(DbService) private readonly db: DbService) {}

  /**
   * Вставка вопроса.
   *
   * Два уникальных индекса работают вместо двух проверок в коде: `(user_id,
   * idem_key)` — идемпотентность, частичный `where status = 'pending'` — «один
   * вопрос в работе». Обе проверки в коде проигрывают гонку, индексы — нет.
   */
  async insert(input: InsertQuestionInput): Promise<InsertOutcome> {
    const row = await this.db.queryOne<QuestionRow>(
      `INSERT INTO questions
         (user_id, local_date, timezone, question, question_hash, question_len, topic,
          status, idem_key, engine_version, prompt_version)
       VALUES ($1, $2::date, $3, $4, $5, $6, $7, 'pending', $8, $9, $10)
       ON CONFLICT DO NOTHING
       RETURNING ${COLUMNS}`,
      [
        input.userId,
        input.localDate,
        input.timezone,
        input.question,
        input.questionHash,
        input.question.length,
        input.topic,
        input.idemKey,
        input.engineVersion,
        input.promptVersion,
      ],
    );

    if (row !== null) {
      return { kind: 'created', row };
    }

    const duplicate = await this.byIdemKey(input.userId, input.idemKey);
    if (duplicate !== null) {
      return { kind: 'duplicate', row: duplicate };
    }

    return { kind: 'in_progress' };
  }

  async byIdemKey(userId: string, idemKey: string): Promise<QuestionRow | null> {
    return this.db.queryOne<QuestionRow>(
      `SELECT ${COLUMNS} FROM questions WHERE user_id = $1 AND idem_key = $2`,
      [userId, idemKey],
    );
  }

  async findById(id: string, userId: string): Promise<QuestionRow | null> {
    return this.db.queryOne<QuestionRow>(
      `SELECT ${COLUMNS} FROM questions WHERE id = $1 AND user_id = $2`,
      [id, userId],
    );
  }

  /**
   * История вопросов (контракт 1.6.7): `ready`, `refused`, `pending`.
   *
   * `failed` в список не попадает — решение владельца: сбой генерации это наша
   * внутренняя история, а не ответ карты. Человек видел бы «я спросил и
   * получил ошибку», хотя квота за неудачу не списывается (её возвращает
   * `QuestionsService`).
   *
   * `pending` наоборот отдаётся: по нему клиент восстанавливает экран после
   * закрытия мини-аппа и отличает `409 question_in_progress` от «вопроса не
   * было». `refused` — настоящий ответ («про здоровье не отвечаю»), его прятать
   * нельзя: человек должен видеть, что спросил и получил ответ.
   *
   * Фильтр в SQL — до `LIMIT`: счётчики и будущая пагинация считаются от того
   * же набора, что и список.
   */
  async list(userId: string, limit: number): Promise<QuestionRow[]> {
    return this.db.query<QuestionRow>(
      `SELECT ${COLUMNS}
         FROM questions
        WHERE user_id = $1 AND status IN ('ready', 'refused', 'pending')
        ORDER BY created_at DESC, id DESC
        LIMIT $2`,
      [userId, limit],
    );
  }

  async markReady(
    id: string,
    bodyMd: string,
    chars: number,
    warnings: readonly string[],
  ): Promise<void> {
    await this.db.query(
      `UPDATE questions
          SET status = 'ready', body_md = $2, chars = $3, warnings = $4::jsonb,
              duration_ms = GREATEST(1, (extract(epoch from now() - created_at) * 1000)::int)
        WHERE id = $1`,
      [id, bodyMd, chars, JSON.stringify(warnings)],
    );
  }

  /** Отказ: квота не тратится, расход нулевой, модель не вызывалась. */
  async markRefused(id: string, reason: string): Promise<void> {
    await this.db.query(
      `UPDATE questions
          SET status = 'refused', reason = $2,
              duration_ms = GREATEST(0, (extract(epoch from now() - created_at) * 1000)::int)
        WHERE id = $1`,
      [id, reason],
    );
  }

  async markFailed(id: string, reason: string): Promise<void> {
    await this.db.query(
      `UPDATE questions
          SET status = 'failed', reason = $2,
              duration_ms = GREATEST(0, (extract(epoch from now() - created_at) * 1000)::int)
        WHERE id = $1`,
      [id, reason],
    );
  }

  async addCost(id: string, costRub: number): Promise<void> {
    await this.db.query(`UPDATE questions SET cost_rub = cost_rub + $2::numeric WHERE id = $1`, [
      id,
      costRub,
    ]);
  }

  /** Сколько вопросов задано в эту местную дату. */
  async usedToday(userId: string, localDate: string): Promise<number> {
    const row = await this.db.queryOne<{ count: number }>(
      `SELECT count FROM question_usage WHERE user_id = $1 AND local_date = $2::date`,
      [userId, localDate],
    );
    return row?.count ?? 0;
  }

  /**
   * Списать одну попытку квоты.
   *
   * `INSERT … ON CONFLICT DO UPDATE … WHERE count < limit` — атомарно: два
   * одновременных вопроса не могут оба увидеть «осталось одно». Если строка не
   * вернулась, лимит исчерпан (`usedNow` показывает фактическое значение).
   */
  async takeQuota(userId: string, localDate: string, limit: number): Promise<boolean> {
    const row = await this.db.queryOne<{ count: number }>(
      `INSERT INTO question_usage (user_id, local_date, count)
       VALUES ($1, $2::date, 1)
       ON CONFLICT (user_id, local_date) DO UPDATE
         SET count = question_usage.count + 1
       WHERE question_usage.count < $3
       RETURNING count`,
      [userId, localDate, limit],
    );

    return row !== null;
  }

  /**
   * Вернуть попытку квоты.
   *
   * Нужна там, где квота уже списана, а вопроса не будет: гонка `409` или
   * повтор с тем же ключом идемпотентности. Без возврата двойной тап съедал бы
   * две попытки из трёх без единого ответа.
   */
  async refundQuota(userId: string, localDate: string): Promise<void> {
    await this.db.query(
      `UPDATE question_usage
          SET count = GREATEST(count - 1, 0)
        WHERE user_id = $1 AND local_date = $2::date`,
      [userId, localDate],
    );
  }

  /** Расход на вопросы за местную дату — дневной потолок. */
  async costToday(userId: string, localDate: string): Promise<number> {
    const row = await this.db.queryOne<{ cost: string }>(
      `SELECT COALESCE(SUM(cost_rub), 0)::text AS cost
         FROM questions
        WHERE user_id = $1 AND local_date = $2::date`,
      [userId, localDate],
    );
    return Number(row?.cost ?? '0');
  }
}
