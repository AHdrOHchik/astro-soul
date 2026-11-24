import { Inject, Injectable } from '@nestjs/common';
import { APP_ENV } from '../../config/env.module';
import type { AppEnv } from '../../config/env';

/**
 * Лимит попыток активации кода: 10 **неудач** в час на пользователя (1.6.17).
 *
 * Зачем. `POST /me/activate-code` принимает восьмизначный код из алфавита в 32
 * символа. Перебор 32^8 по сети нереален, но «10 000 запросов в минуту с одного
 * аккаунта» — это не перебор кода, это перебор **наших** ресурсов: каждый запрос
 * идёт в базу, а найденный чужим перебором код — это подаренный доступ. Общий
 * лимит запросов (60 в минуту) такого не ловит: 60 запросов в минуту — это 3600
 * попыток в час.
 *
 * Три решения, повторяющие `AdminLoginThrottle` (и намеренно):
 *
 *   1. **Считаем неудачи, а не попытки.** Успешная активация обнуляет счётчик:
 *      человек, который ошибся дважды и попал с третьей попытки, не должен
 *      упираться в лимит — это ровно тот случай, который проверяет тест.
 *   2. **Проверка стоит до похода в базу.** Заблокированный запрос не ищет код и
 *      не трогает `access_codes`: перебор не должен быть работой сервера.
 *   3. **Счётчики в памяти процесса.** Redis в песочнице нет, инстанс API один;
 *      при масштабировании лимит умножится на число подов — это записано в
 *      docs/ADMIN.md, как и у общего rate-limit.
 *
 * Время — поле, а не аргумент конструктора: тест «окно открылось через час»
 * двигает часы, а не ждёт час (Nest не умеет внедрять функцию).
 */

interface Bucket {
  failures: number;
  resetAt: number;
}

/** Окно — час: лимит сформулирован как «10 попыток в час». */
const WINDOW_MS = 60 * 60 * 1000;

@Injectable()
export class CodeActivationThrottle {
  private readonly buckets = new Map<string, Bucket>();

  /** Часы: двигаются в тестах, в проде — системное время. */
  now: () => number = Date.now;

  constructor(@Inject(APP_ENV) private readonly env: AppEnv) {}

  private get maxFailures(): number {
    return this.env.CODE_ACTIVATION_MAX_FAILURES;
  }

  /** Сколько секунд ждать до следующей попытки; `null` — можно пробовать. */
  retryAfterSeconds(userId: string): number | null {
    const bucket = this.active(userId);

    if (bucket === null || bucket.failures < this.maxFailures) {
      return null;
    }

    return Math.max(1, Math.ceil((bucket.resetAt - this.now()) / 1000));
  }

  /** Неудачная попытка: код не найден, исчерпан, просрочен, уже активирован. */
  registerFailure(userId: string): void {
    const existing = this.active(userId);

    if (existing === null) {
      this.buckets.set(userId, { failures: 1, resetAt: this.now() + WINDOW_MS });
      if (this.buckets.size > 5_000) {
        this.sweep();
      }
      return;
    }

    existing.failures += 1;

    // Окно не продлевается: иначе серия неудач держала бы человека в блоке
    // бесконечно (классическая ошибка «счётчик со сдвигом»).
  }

  /** Успешная активация: счётчик неудач снимается. */
  registerSuccess(userId: string): void {
    this.buckets.delete(userId);
  }

  private active(userId: string): Bucket | null {
    const bucket = this.buckets.get(userId);

    if (bucket === undefined) {
      return null;
    }

    if (bucket.resetAt <= this.now()) {
      this.buckets.delete(userId);
      return null;
    }

    return bucket;
  }

  private sweep(): void {
    const now = this.now();

    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) {
        this.buckets.delete(key);
      }
    }
  }
}
