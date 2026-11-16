/**
 * Очередь к Nominatim: не больше одного запроса в секунду.
 *
 * Требование политики Nominatim и `geo.md`. Очередь в процессе: подсказки
 * приходят от одного инстанса, а кэш снимает повторы. При нескольких
 * инстансах лимит делится между ними — это записано в `geo.md`.
 */
export class NominatimThrottle {
  private nextAllowedAt = 0;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly minIntervalMs: number,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((resolve) => {
        const timer = setTimeout(resolve, ms);
        timer.unref();
      }),
  ) {}

  /**
   * Выполняет вызов, соблюдая интервал. Вызовы выстраиваются в очередь:
   * параллельные запросы не «обгоняют» друг друга и не ломают интервал.
   */
  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(async () => {
      const waitMs = this.nextAllowedAt - this.now();
      if (waitMs > 0) {
        await this.sleep(waitMs);
      }
      this.nextAllowedAt = this.now() + this.minIntervalMs;
      return task();
    });

    // Ошибка одного вызова не должна останавливать очередь.
    this.tail = result.catch(() => undefined);
    return result;
  }
}
