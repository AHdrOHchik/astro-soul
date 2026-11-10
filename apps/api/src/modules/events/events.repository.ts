import { Inject, Injectable } from '@nestjs/common';
import { DbService } from '../../db/db.service';
import { currentRequestId } from '../../common/request-context';

export interface EventInput {
  readonly name: string;
  readonly userId?: string | null;
  readonly props?: Record<string, unknown>;
  /** Время события на клиенте; `null` — событие сервера (платежи, удаление). */
  readonly occurredAt?: Date | null;
}

/**
 * Продуктовые события и аудит. Свойства — только идентификаторы и флаги:
 * в `events` запрещены ПДн (CHECK на размер props в миграции 0004).
 */
@Injectable()
export class EventsRepository {
  constructor(@Inject(DbService) private readonly db: DbService) {}

  async log(event: EventInput): Promise<void> {
    await this.db.query(
      `INSERT INTO events (user_id, name, props, request_id) VALUES ($1, $2, $3::jsonb, $4)`,
      [event.userId ?? null, event.name, JSON.stringify(event.props ?? {}), currentRequestId()],
    );
  }

  /**
   * Батч клиентских событий одним запросом: 20 отдельных `INSERT` на батч —
   * лишние round-trip'ы там, где важна скорость экрана.
   */
  async logBatch(events: readonly EventInput[]): Promise<void> {
    if (events.length === 0) {
      return;
    }

    // Ключи — ровно имена колонок в `jsonb_to_recordset`, иначе поля
    // молча приходят как NULL (camelCase здесь не работает).
    const payload = events.map((event) => ({
      user_id: event.userId ?? null,
      name: event.name,
      props: event.props ?? {},
      occurred_at: event.occurredAt?.toISOString() ?? null,
    }));

    await this.db.query(
      `INSERT INTO events (user_id, name, props, occurred_at, request_id)
       SELECT row.user_id, row.name, row.props, row.occurred_at, $2
         FROM jsonb_to_recordset($1::jsonb)
              AS row(user_id uuid, name text, props jsonb, occurred_at timestamptz)`,
      [JSON.stringify(payload), currentRequestId()],
    );
  }
}
