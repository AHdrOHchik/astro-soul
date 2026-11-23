import { Inject, Injectable } from '@nestjs/common';
import { DbService } from '../../db/db.service';
import { JsonLogger } from '../../common/logger';
import { UsersRepository } from './users.repository';

/**
 * Присутствие: когда человек последний раз открывал приложение (итерация 38).
 *
 * Зачем. Утренний пуш не должен приходить тому, кто в это утро уже зашёл:
 * он сам увидит разбор дня, а второе сообщение в чате — навязчивость. Правило
 * проверяется по `users.last_seen_at` внутри SQL рассылки, но кто-то должен
 * эту колонку заполнять. Естественное место — авторизация: любой запрос
 * мини-аппа уже прошёл проверку initData, и это самое честное «человек здесь».
 *
 * Почему не на каждый запрос. Открытие экрана — это 5–10 запросов; писать в
 * `users` каждый раз значит добавить UPDATE в горячий путь ради значения,
 * точность которого измеряется минутами. Поэтому в памяти процесса держим
 * «обновляли не раньше минуты назад» — при нескольких инстансах API это
 * максимум один UPDATE в минуту на инстанс, и для правила 07:30 этого хватает.
 *
 * Почему не бросает. Присутствие — не часть ответа: если UPDATE не прошёл,
 * человек всё равно должен получить свой экран. Ошибка уходит в лог один раз
 * (warn), а не роняет запрос.
 */
@Injectable()
export class PresenceService {
  /** Как часто обновлять одну и ту же строку. Минута — точность правила 07:30. */
  static readonly TOUCH_INTERVAL_MS = 60_000;

  private readonly touched = new Map<string, number>();

  constructor(
    @Inject(DbService) private readonly db: DbService,
    @Inject(UsersRepository) private readonly users: UsersRepository,
    @Inject(JsonLogger) private readonly logger: JsonLogger,
  ) {}

  /**
   * Отметить визит. Не ждём результата: `void` + `catch` — осознанно, иначе
   * `unhandledRejection` уронил бы процесс из-за необязательного UPDATE.
   */
  touch(telegramUserId: bigint): void {
    const key = telegramUserId.toString();
    const now = Date.now();
    const last = this.touched.get(key);

    if (last !== undefined && now - last < PresenceService.TOUCH_INTERVAL_MS) {
      return;
    }

    this.touched.set(key, now);
    const userId = this.users.userIdFor(telegramUserId);

    void this.db
      .query(`UPDATE users SET last_seen_at = now() WHERE id = $1`, [userId])
      .catch((error: unknown) => {
        this.logger.warn('presence_touch_failed', {
          reason: error instanceof Error ? error.name : 'unknown',
        });
      });
  }

  /**
   * Сброс памяти отметок. Нужен тестам и ручной диагностике: без него
   * «минута» из одного процесса переживает `truncateAll`.
   */
  reset(): void {
    this.touched.clear();
  }
}
