import { VALIDATION_FAILURE_CODES } from './failure-codes';

/**
 * Circuit breaker конвейера разборов.
 *
 * Зачем: массовый провал валидации молча жёг бюджет — пять попыток по ~0,85 ₽
 * на разбор, и это повторялось на каждом новом заказе. После трёх провалов
 * подряд новые разборы не запускаются, состояние видно в `/admin/metrics`.
 *
 * Как закрывается: сам, по времени. Провалы старше `BREAKER_COOLDOWN_MS` не
 * держат брейкер открытым, поэтому после починки промпта и деплоя достаточно
 * подождать окно — ручного «сброса кнопкой» нет, и это осознанно: сброс без
 * починки вернул бы ровно ту же серию провалов.
 */
export const BREAKER_THRESHOLD = 3;
export const BREAKER_COOLDOWN_MS = 30 * 60 * 1000;

export interface BreakerState {
  /** Сколько провалов валидации подряд (по `error_code`), начиная с последнего. */
  readonly streak: number;
  readonly open: boolean;
  /** Через сколько миллисекунд брейкер закроется сам (`null` — уже закрыт). */
  readonly retry_after_ms: number | null;
  readonly last_failed_at: string | null;
}

/**
 * Состояние брейкера по «серии» провалов.
 *
 * `streak` считается по `error_code` подряд идущих разборов: успешный разбор
 * (`error_code = null`) серию обнуляет, поэтому считать статус (`refunded`)
 * нельзя — возврат звёзд статус меняет, а причину провала нет.
 */
export function breakerState(
  streak: number,
  lastFailedAt: Date | null,
  now: Date = new Date(),
): BreakerState {
  const last = lastFailedAt === null ? null : lastFailedAt.toISOString();
  if (streak < BREAKER_THRESHOLD || lastFailedAt === null) {
    return { streak, open: false, retry_after_ms: null, last_failed_at: last };
  }

  const elapsed = now.getTime() - lastFailedAt.getTime();
  if (elapsed >= BREAKER_COOLDOWN_MS) {
    return { streak, open: false, retry_after_ms: null, last_failed_at: last };
  }

  return {
    streak,
    open: true,
    retry_after_ms: BREAKER_COOLDOWN_MS - Math.max(0, elapsed),
    last_failed_at: last,
  };
}

/** Одна строка истории разборов: из неё считается серия. */
export interface ReportHistoryRow {
  readonly error_code: string | null;
  readonly updated_at: Date;
}

/** Серия провалов валидации: ведущие строки истории с таким `error_code`. */
export function validationStreak(rows: readonly ReportHistoryRow[]): {
  readonly streak: number;
  readonly lastFailedAt: Date | null;
} {
  let streak = 0;
  let lastFailedAt: Date | null = null;

  for (const row of rows) {
    if (row.error_code === null || !VALIDATION_FAILURE_CODES.includes(row.error_code)) {
      break;
    }
    streak += 1;
    lastFailedAt ??= row.updated_at;
  }

  return { streak, lastFailedAt };
}
