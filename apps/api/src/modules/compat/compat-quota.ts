/**
 * Права и квоты совместимости — правило в одном месте, без похода в БД.
 *
 * Решение владельца: разовая покупка `compat_249` — одна совместимость;
 * подписка — одна в 30 дней, окно **скользящее**. Скользящее окно выбрано
 * потому, что календарное «месяц с 1-го» давало бы человеку две совместимости
 * за три дня на стыке месяцев, а «от даты оплаты» — 28 февраля против 31
 * января. Скользящее окно не льстит никому и не зависит от дня оплаты.
 *
 * Сброс — ленивый: отдельного джоба нет. Окно пересчитывается при чтении,
 * потому что `resets_at` — это тоже чтение, а джоб, который «должен был
 * сбросить», — это ещё одна точка отказа.
 */

/** Длина окна подписки: 30 дней, ровно как в обещании «1 в месяц». */
export const COMPAT_WINDOW_DAYS = 30;
export const COMPAT_WINDOW_MS = COMPAT_WINDOW_DAYS * 24 * 60 * 60 * 1000;

export type CompatQuotaKind = 'purchase' | 'subscription' | 'none';

export interface CompatQuota {
  readonly kind: CompatQuotaKind;
  /** Сколько совместимостей можно заказать прямо сейчас: 0 или 1. */
  readonly left: number;
  /** Когда окно подписки откроется снова; `null` — ждать нечего. */
  readonly resets_at: string | null;
}

export interface CompatQuotaInput {
  /** Есть ли неизрасходованный разовый кредит (`entitlements.used_at IS NULL`). */
  readonly purchaseCredit: boolean;
  /** Активная подписка: начало (`created_at`) и конец (`expires_at`). */
  readonly subscription: { readonly startedAt: Date; readonly expiresAt: Date } | null;
  /** Момент последней **готовой** совместимости — вход скользящего окна. */
  readonly lastReadyAt: Date | null;
  /** «Сейчас» передаётся аргументом, чтобы тест мог сдвинуть время. */
  readonly now?: Date;
}

/**
 * Начало текущего окна подписки.
 *
 * Это `max(startedAt, now − 30 дней)`: окно не может начаться раньше, чем
 * человек купил подписку (иначе первый месяц короче тридцати дней), и не
 * может тянуться дальше тридцати дней (иначе «1 в месяц» превращается
 * в «1 за подписку»).
 */
export function windowStart(
  subscription: { readonly startedAt: Date },
  now: Date,
): Date {
  const rolling = new Date(now.getTime() - COMPAT_WINDOW_MS);
  return subscription.startedAt > rolling ? subscription.startedAt : rolling;
}

export function quotaOf(input: CompatQuotaInput): CompatQuota {
  const now = input.now ?? new Date();

  // Разовая покупка приоритетнее подписки: она не сгорает, и тратить её
  // человек должен тогда, когда решил сам.
  if (input.purchaseCredit) {
    return { kind: 'purchase', left: 1, resets_at: null };
  }

  const subscription = input.subscription;
  if (subscription === null || subscription.expiresAt <= now) {
    return { kind: 'none', left: 0, resets_at: null };
  }

  const start = windowStart(subscription, now);
  const used =
    input.lastReadyAt !== null && input.lastReadyAt.getTime() >= start.getTime();

  if (!used) {
    return { kind: 'subscription', left: 1, resets_at: null };
  }

  const resets = new Date(start.getTime() + COMPAT_WINDOW_MS);
  return { kind: 'subscription', left: 0, resets_at: resets.toISOString() };
}

/** Отказ по исчерпанной квоте: 402 для покупки, 422 для подписки. */
export function quotaExhaustedStatus(quota: CompatQuota): 402 | 422 {
  return quota.kind === 'subscription' ? 422 : 402;
}
