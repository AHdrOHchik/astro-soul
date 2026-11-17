import { describe, expect, it } from 'vitest';
import { DeadlineError, withDeadline } from './deadline';

describe('withDeadline', () => {
  it('быстрая работа возвращает результат, таймер не мешает', async () => {
    await expect(withDeadline(Promise.resolve('ok'), 50)).resolves.toBe('ok');
  });

  it('медленная работа → DeadlineError с тем же сроком', async () => {
    const slow = new Promise((resolve) => setTimeout(resolve, 200));

    await expect(withDeadline(slow, 10)).rejects.toBeInstanceOf(DeadlineError);
    await expect(withDeadline(new Promise((resolve) => setTimeout(resolve, 200)), 5)).rejects.toMatchObject({
      deadlineMs: 5,
    });
  });

  it('поздний отказ брошенной работы не роняет процесс', async () => {
    const late = new Promise((_resolve, reject) => setTimeout(() => reject(new Error('поздний отказ')), 30));

    await expect(withDeadline(late, 5)).rejects.toBeInstanceOf(DeadlineError);
    // Ждём, пока брошенная работа откажет: с Node 15 необработанный отказ —
    // падение процесса, а не запись в лог, и это ровно тот случай, когда
    // «не успели ответить» превращалось бы в «сервер упал».
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(true).toBe(true);
  });
});
