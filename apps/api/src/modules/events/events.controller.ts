import { Body, Controller, HttpCode, Inject, Post } from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator';
import type { VerifiedInitData } from '../auth/init-data';
import { EventsService } from './events.service';

/**
 * `POST /api/v1/events` — события продукта батчем (контракт 1.3.0).
 *
 * Всегда `202` для корректного батча: аналитика не должна задерживать
 * интерфейс. Ошибки формы — `422` с `field_errors`; фронт на них не реагирует.
 */
@Controller('events')
export class EventsController {
  constructor(@Inject(EventsService) private readonly events: EventsService) {}

  @Post()
  @HttpCode(202)
  async accept(@CurrentUser() auth: VerifiedInitData, @Body() body: unknown): Promise<{ accepted: number }> {
    const accepted = await this.events.accept(auth, body);
    return { accepted };
  }
}
