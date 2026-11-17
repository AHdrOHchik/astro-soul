/**
 * Жёсткий срок на асинхронную работу — для обработчиков, у которых есть
 * внешний дедлайн (Telegram даёт на `pre_checkout_query` 10 секунд).
 *
 * Зачем свой: `AbortSignal.timeout` умеет отменять только `fetch`, а нам нужен
 * срок на «прочитать три таблицы», где отменить уже начатый SQL-запрос из JS
 * нельзя. Поэтому гонка: работа продолжается в фоне, а вызывающий получает
 * отказ ровно через `ms` и успевает ответить внешней системе.
 *
 * Важно: брошенный `DeadlineError` — это «не успели», а не «ошибка». Разница
 * видна в логе (`pre_checkout_timeout` против `pre_checkout_rejected`), и
 * именно она отличает «медленная база» от «неверный счёт».
 */
export class DeadlineError extends Error {
  constructor(readonly deadlineMs: number) {
    super(`не уложились в ${String(deadlineMs)} мс`);
    this.name = 'DeadlineError';
  }
}

export async function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;

  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new DeadlineError(ms));
    }, ms);
    // Таймер не должен держать процесс живым (тесты, graceful shutdown).
    timer.unref?.();
  });

  // Работа продолжается после срока: её поздний отказ не должен стать
  // unhandled rejection (с Node 15 это падение процесса, а не запись в лог).
  // На результат гонки это не влияет — `Promise.race` свой обработчик имеет.
  void work.catch(() => undefined);

  try {
    return await Promise.race([work, deadline]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}
