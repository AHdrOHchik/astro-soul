/**
 * Разбор `limit`/`offset` из query (контракт 1.6.8).
 *
 * Мусор в параметре не должен давать 422: пагинация — служебная вещь, и
 * клиент, приславший `?limit=abc`, хочет список, а не разбор ошибки. Поэтому
 * «не число» приравнивается к «не передано», а «слишком много» — к максимуму.
 *
 * Верхняя граница обязательна: без неё `?limit=1000000` превращается в способ
 * бесплатно нагрузить базу.
 */
export function pageLimit(raw: string | undefined, max: number): number {
  return clampParam(raw, max, max);
}

/** Смещение: по умолчанию 0, отрицательное и мусор — тоже 0. */
export function pageOffset(raw: string | undefined, max = 10_000): number {
  return clampParam(raw, 0, max);
}

function clampParam(raw: string | undefined, fallback: number, max: number): number {
  if (raw === undefined || raw.trim() === '') {
    return fallback;
  }

  const value = Number(raw);
  if (!Number.isFinite(value)) {
    return fallback;
  }

  return Math.min(max, Math.max(0, Math.trunc(value)));
}
