/**
 * Права и квоты совместимости — правило в одном месте, без похода в БД.
 *
 * Решение владельца: разовая покупка `compat_249` — одна совместимость;
 * подписка — одна в 30 дней. Окно отсчитывается **от последней готовой
 * совместимости**, а не от даты оплаты и не «30 дней назад от сейчас».
 *
 * Почему так (итерация 23, замок в `compat.spec.ts`): при якоре «30 дней
 * назад от сейчас» человек, забравший совместимость 10 дней назад, видел
 * `resets_at` = «сейчас» и получал новую через 20 дней, а не через 30, —
 * то есть окно было не 30 дней, а «от последней готовой до 30 дней после
 * последней готовой». Якорь на последней готовой даёт ровно обещанное:
 * следующая — через 30 дней после предыдущей.
 *
 * Раньше начала подписки окно не начинается: совместимость, собранная
 * по прошлой подписке, не тратит текущую.
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
  /** Момент последней **готовой** совместимости — якорь окна подписки. */
  readonly lastReadyAt: Date | null;
  /** «Сейчас» передаётся аргументом, чтобы тест мог сдвинуть время. */
  readonly now?: Date;
}

/**
 * Начало текущего окна подписки — дата последней **готовой** совместимости.
 *
 * `null` — окно открыто: либо готовой совместимости ещё не было, либо она
 * собрана раньше начала текущей подписки (её окно не тратит).
 * `resets_at` считается от возвращённой даты, а не от `now`: иначе окно
 * «плывёт» вместе с часами и сбрасывается не через 30 дней, а когда
 * последняя готовая выйдет за горизонт в 30 дней.
 */
export function windowStart(
  subscription: { readonly startedAt: Date },
  lastReadyAt: Date | null,
): Date | null {
  if (lastReadyAt === null || lastReadyAt.getTime() < subscription.startedAt.getTime()) {
    return null;
  }
  return lastReadyAt;
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

  const start = windowStart(subscription, input.lastReadyAt);
  if (start === null) {
    return { kind: 'subscription', left: 1, resets_at: null };
  }

  const resets = new Date(start.getTime() + COMPAT_WINDOW_MS);
  if (now.getTime() >= resets.getTime()) {
    return { kind: 'subscription', left: 1, resets_at: null };
  }

  return { kind: 'subscription', left: 0, resets_at: resets.toISOString() };
}

/** Отказ по исчерпанной квоте: 402 для покупки, 422 для подписки. */
export function quotaExhaustedStatus(quota: CompatQuota): 402 | 422 {
  return quota.kind === 'subscription' ? 422 : 402;
}
