import { Inject, Injectable } from '@nestjs/common';
import type { VerifiedInitData } from '../auth/init-data';
import { UsersRepository } from '../users/users.repository';
import { JsonLogger } from '../../common/logger';
import { EventsRepository, type EventInput } from './events.repository';
import { parseEventsBatch } from './events.dto';

/** Клиентские события: разбор, чистка и запись батчем. */
@Injectable()
export class EventsService {
  constructor(
    @Inject(EventsRepository) private readonly events: EventsRepository,
    @Inject(UsersRepository) private readonly users: UsersRepository,
    @Inject(JsonLogger) private readonly logger: JsonLogger,
  ) {}

  /**
   * Возвращает число записанных событий. Ответ клиенту — `202`: приём
   * подтверждён, но ждать его интерфейсу незачем.
   */
  async accept(auth: VerifiedInitData, body: unknown, now: Date = new Date()): Promise<number> {
    const batch = parseEventsBatch(body, now);

    if (batch.droppedForPrivacy > 0) {
      // Не 422: клиент уже отправил данные, повтор ничего не изменит.
      this.logger.warn('events_dropped_personal_data', { count: batch.droppedForPrivacy });
    }

    if (batch.events.length === 0) {
      return 0;
    }

    const userId = this.users.userIdFor(auth.telegramUserId);
    const rows: EventInput[] = batch.events.map((event) => ({
      name: event.name,
      userId,
      occurredAt: new Date(event.occurred_at),
      props: event.props ?? {},
    }));

    await this.events.logBatch(rows);
    return rows.length;
  }
}
