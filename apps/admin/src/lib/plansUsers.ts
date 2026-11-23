/*
 * Чистые правила двух экранов — «Тарифы» и «Пользователи». Здесь живёт
 * решение, а не отрисовка: так оно тестируется без React, а экран не получает
 * права придумывать проверку на ходу.
 */

import type { AdminPlanRow, UsersSearchParams } from '../api/types';

export type SearchMode = 'telegram_id' | 'alias' | 'q';

export type SearchBuild =
  | { readonly ok: true; readonly params: UsersSearchParams }
  | { readonly ok: false; readonly error: 'empty' | 'telegram_digits' };

const TELEGRAM_ID = /^\d{1,20}$/;

/**
 * Собрать запрос поиска: ровно один параметр, как требует сервер.
 * `@` у alias срезаем — человек вставляет ник из мессенджера вместе с ним,
 * а сервер ждёт голое имя; пробелы по краям — то же самое.
 */
export function buildUsersSearch(mode: SearchMode, raw: string): SearchBuild {
  const value = raw.trim();
  if (mode === 'telegram_id') {
    if (value === '') return { ok: false, error: 'empty' };
    return TELEGRAM_ID.test(value) ? { ok: true, params: { telegram_id: value } } : { ok: false, error: 'telegram_digits' };
  }
  if (mode === 'alias') {
    const alias = value.replace(/^@+/, '');
    return alias === '' ? { ok: false, error: 'empty' } : { ok: true, params: { alias } };
  }
  return value === '' ? { ok: false, error: 'empty' } : { ok: true, params: { q: value } };
}

/**
 * Право на строку «Основательский» не редактируется никогда — ни ценой, ни
 * флагом: витрины у тарифа нет, и `PATCH /admin/plans/{code}` его не касается
 * (ответ владельца, §5). Решает флаг сервера, а не список кодов в панели.
 */
export function planEditLocked(plan: AdminPlanRow): boolean {
  return plan.founder_only;
}

export interface PriceForm {
  readonly price: string;
  readonly discount: string;
  readonly comment: string;
}

export interface PriceFormCheck {
  readonly valid: boolean;
  readonly priceStars: number;
  readonly discountStars: number | null;
  /** `true` — значение отличается от серверного, есть что сохранять. */
  readonly changed: boolean;
}

/**
 * Цена — целое число звёзд 1..100 000; скидка — целая, строго меньше цены
 * или отсутствует; основание — непустая строка. Больше клиент не решает:
 * «сколько стоит» отвечает сервер, и финальную валидацию делает он же.
 */
export function checkPriceForm(form: PriceForm, plan: AdminPlanRow): PriceFormCheck {
  const price = Number(form.price);
  const discount = form.discount.trim() === '' ? null : Number(form.discount);
  const priceOk = /^\d+$/.test(form.price.trim()) && Number.isInteger(price) && price >= 1 && price <= 100_000;
  const discountOk =
    discount === null ||
    (/^\d+$/.test(form.discount.trim()) && Number.isInteger(discount) && discount >= 1 && discount < price);
  const changed = price !== plan.price_stars || discount !== plan.discount_price_stars;
  return {
    valid: priceOk && discountOk && changed && form.comment.trim() !== '',
    priceStars: price,
    discountStars: discount,
    changed,
  };
}

/**
 * Эхо-подтверждение: человек повторяет число, которое ему показал сервер
 * (новую цену или сумму полного возврата). Сверка — по цифрам после
 * обрезки: неразрывные пробелы из форматированного вывода не «ломают»
 * совпадение, но и «25 0» не принимает — это другое число.
 */
export function echoMatches(text: string, amount: number): boolean {
  const clean = text.replaceAll('\u00a0', '').replaceAll('\u202f', '').trim();
  return clean === String(amount);
}
