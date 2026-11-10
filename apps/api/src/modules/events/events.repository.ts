import { Inject, Injectable } from '@nestjs/common';
import { DbService } from '../../db/db.service';
import { currentRequestId } from '../../common/request-context';

export interface EventInput {
  readonly name: string;
  readonly userId?: string | null;
  readonly props?: Record<string, unknown>;
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
}
