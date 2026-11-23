import { Inject, Injectable } from '@nestjs/common';
import { DbService } from '../../db/db.service';
import { JsonLogger } from '../../common/logger';
import { EventsRepository } from '../events/events.repository';
import { UsersRepository } from '../users/users.repository';
import { TelegramClient } from './telegram.client';

/**
 * Обработка `callback_query` кнопки «Отключить» в утреннем пуше (итерация 38).
 *
 * Что требуется от отказа:
 *   • одно нажатие — и больше не приходит: `users.push_enabled = false`, то же
 *     поле, что `Me.notifications.daily_forecast` и `POST /me/notifications`;
 *   • **никакого нового сообщения в чате**: `answerCallbackQuery` показывает
 *     всплывающую подсказку, и это единственный видимый ответ. Иначе отказ
 *     порождал бы сообщение, то есть ровно то, от чего человек отказывается;
 *   • идемпотентность: повторное нажатие (Telegram повторяет доставку, человек
 *     ткнул дважды) не меняет ничего и не считается ошибкой.
 *
 * Текст подсказки — дословно обещанный: «Больше не буду присылать. Включить
 * можно в кабинете». Второй половиной фразы мы не врём: тумблер живёт в
 * кабинете и пишет в то же поле (`POST /me/notifications`).
 */
export const PUSH_OFF_ACK = 'Больше не буду присылать. Включить можно в кабинете';
/** `callback_data`, которую ставит кнопка в пуше. Значение — часть контракта. */
export const PUSH_OFF_CALLBACK_DATA = 'push_off';

export interface CallbackQueryUpdate {
  /** `callback_query.id` — обязателен для `answerCallbackQuery`. */
  readonly id: string;
  readonly data: string;
  /** Кто нажал: по нему находим псевдоним в `users`. */
  readonly telegramUserId: bigint | null;
}

@Injectable()
export class PushCallbackService {
  constructor(
    @Inject(DbService) private readonly db: DbService,
    @Inject(TelegramClient) private readonly telegram: TelegramClient,
    @Inject(UsersRepository) private readonly users: UsersRepository,
    @Inject(EventsRepository) private readonly events: EventsRepository,
    @Inject(JsonLogger) private readonly logger: JsonLogger,
  ) {}

  /** `true` — апдейт наш (кнопка пуша) и обработан. */
  async handleCallback(query: CallbackQueryUpdate): Promise<boolean> {
    if (query.data !== PUSH_OFF_CALLBACK_DATA) {
      return false;
    }

    if (query.telegramUserId !== null) {
      const userId = this.users.userIdFor(query.telegramUserId);

      // Идемпотентно: `WHERE push_enabled` — повторное нажатие не пишет строку
      // в журнал второй раз и не считается отказом «заново».
      const updated = await this.db.queryOne<{ id: string }>(
        `UPDATE users SET push_enabled = false
          WHERE id = $1 AND push_enabled
          RETURNING id`,
        [userId],
      );

      if (updated !== null) {
        await this.events.log({
          userId,
          name: 'push_disabled',
          props: { reason: 'button' },
        });
        this.logger.info('push_off', { user: 'self' });
      }
    }

    // Ответ обязателен всегда: без него на кнопке «крутится» индикатор.
    await this.telegram.answerCallbackQuery(query.id, PUSH_OFF_ACK);

    return true;
  }
}
