import { Inject, Injectable } from '@nestjs/common';
import { APP_ENV } from '../../config/env.module';
import type { AppEnv } from '../../config/env';

/**
 * Ограничение попыток входа в панель: 10 неудач за 15 минут с одного IP.
 *
 * Три решения, которые здесь важны:
 *
 *   1. **Считаем неудачи, а не запросы.** Успешный вход обнуляет счётчик:
 *      иначе человек, трижды промахнувшийся мимо виджета утром, к обеду
 *      закрыл бы себе вход, ничего не нарушив.
 *   2. **Проверка стоит до проверки подписи.** Заблокированный запрос не
 *      считает HMAC и не трогает `bot_token` — перебор строк входа не должен
 *      быть вычислительной работой сервера.
 *   3. **Окно скользящее по ключу.** Ключ — IP (через хэш, см. сервис сессий),
 *      счётчики в памяти процесса: Redis в песочнице нет, а один инстанс API
 *      у нас один. При масштабировании лимит умножится на число подов — это
 *      записано в docs/ADMIN.md, как и у общего rate-limit.
 *
 * Время — аргумент: без этого тест «через 15 минут окно открылось» ждал бы
 * 15 минут.
 */

interface Bucket {
  failures: number;
  resetAt: number;
}

@Injectable()
export class AdminLoginThrottle {
  private readonly buckets = new Map<string, Bucket>();

  /**
   * Часы — поле, а не аргумент конструктора: Nest не умеет внедрять функцию,
   * а тест «окно открылось через 15 минут» должен двигать время, а не ждать.
   */
  now: () => number = Date.now;

  constructor(@Inject(APP_ENV) private readonly env: AppEnv) {}

  private get windowMs(): number {
    return this.env.ADMIN_LOGIN_WINDOW_MINUTES * 60_000;
  }

  /** Сколько секунд ждать до следующей попытки; `null` — можно пробовать. */
  retryAfterSeconds(key: string): number | null {
    const bucket = this.active(key);
    if (bucket === null || bucket.failures < this.env.ADMIN_LOGIN_MAX_ATTEMPTS) {
      return null;
    }
    return Math.max(1, Math.ceil((bucket.resetAt - this.now()) / 1000));
  }

  registerFailure(key: string): void {
    const existing = this.active(key);
    if (existing === null) {
      this.buckets.set(key, { failures: 1, resetAt: this.now() + this.windowMs });
      if (this.buckets.size > 5_000) this.sweep();
      return;
    }
    existing.failures += 1;
  }

  /** Успешный вход: счётчик неудач больше не нужен. */
  registerSuccess(key: string): void {
    this.buckets.delete(key);
  }

  reset(): void {
    this.buckets.clear();
  }

  private active(key: string): Bucket | null {
    const bucket = this.buckets.get(key);
    if (bucket === undefined) {
      return null;
    }
    if (bucket.resetAt <= this.now()) {
      this.buckets.delete(key);
      return null;
    }
    return bucket;
  }

  private sweep(): void {
    const now = this.now();
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) this.buckets.delete(key);
    }
  }
}
