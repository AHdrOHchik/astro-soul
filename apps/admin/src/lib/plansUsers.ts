/*
 * Чистые правила двух экранов — «Тарифы» и «Пользователи». Здесь живёт
 * решение, а не отрисовка: так оно тестируется без React, а экран не получает
 * права придумывать проверку на ходу.
 *
 * Ни одного поля, которого нет в контракте, здесь нет тоже: `checkPriceForm`
 * когда-то проверял `discount_price_stars` — поля, которого в `PATCH
 * /admin/plans/{code}` не было никогда. Оно ушло вместе с ручными типами.
 */

import type { AdminPayment, AdminPlan, UsersSearchParams } from '../api/types';

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
 * Цена тарифа не правится из панели для `founder_month`: её обещали первым 50
 * людям, и сервер отвечает `403 founder_plan_locked`. Решает флаг сервера, а
 * не список кодов в панели. Снимать/ставить `test_only` на этом тарифе можно.
 */
export function planPriceLocked(plan: AdminPlan): boolean {
  return plan.founder_only;
}

export interface PriceForm {
  readonly price: string;
  readonly comment: string;
  readonly testOnly: boolean;
}

export type PriceBlocker = 'invalid_price' | 'nothing_to_update' | 'founder_price_locked' | 'no_comment';

export interface PriceFormCheck {
  readonly valid: boolean;
  readonly priceStars: number;
  /** `null` — флаг не меняется: поля `test_only` в теле тогда нет. */
  readonly testOnly: boolean | null;
  /** Снятие тестового флага = выставить тариф в продажу по его цене. */
  readonly needsConfirm: boolean;
  readonly blocker: PriceBlocker | null;
}

/**
 * Цена — целое число звёзд 1..100 000 (`minimum: 1` в контракте), основание —
 * непустая строка. Больше клиент не решает: «сколько стоит» отвечает сервер, и
 * финальную валидацию делает он же.
 */
export function checkPriceForm(form: PriceForm, plan: AdminPlan): PriceFormCheck {
  const raw = form.price.trim();
  const price = Number(raw);
  const priceOk = /^\d+$/.test(raw) && Number.isInteger(price) && price >= 1 && price <= 100_000;
  const priceChanged = priceOk && price !== plan.price_stars;
  const testOnlyChanged = form.testOnly !== plan.test_only;
  const comment = form.comment.trim();

  let blocker: PriceBlocker | null = null;
  if (comment === '') blocker = 'no_comment';
  else if (raw !== '' && !priceOk) blocker = 'invalid_price';
  else if (priceChanged && planPriceLocked(plan)) blocker = 'founder_price_locked';
  else if (!priceChanged && !testOnlyChanged) blocker = 'nothing_to_update';

  return {
    valid: blocker === null,
    priceStars: priceOk ? price : plan.price_stars,
    testOnly: testOnlyChanged ? form.testOnly : null,
    // `test_only` снимают с тестового тарифа — на это сервер просит эхо-подпись
  // (`confirm: disable_test_plan`). Сравнение — с флагом формы, без `=== false`.
  needsConfirm: plan.test_only && !form.testOnly,
    blocker,
  };
}

/**
 * Возврат делается по одному зарядамому `charge_id`, и только по оплаченному:
 * `refunded` — уже возвращён, `failed` — возвращать нечего. Порядок — как
 * прислал сервер (новые первыми), сортировку панель не устраивает.
 */
export function refundablePayments(payments: readonly AdminPayment[]): readonly AdminPayment[] {
  return payments.filter((item) => item.status === 'paid' || item.status === 'processed');
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

/**
 * Только срок из `retry_after_seconds`: «45 с», «10 мин». `null` — сервер срок
 * не назвал, и придумывать его панель не имеет права. Экраны, которым нужна
 * подпись («Повторить можно через …»), собирают фразу из этой части;
 * `retryAfterText` — готовая строка для тех, где подписи нет.
 */
export function retryAfterDuration(seconds: number | null): string | null {
  if (seconds === null || !Number.isFinite(seconds) || seconds <= 0) return null;
  if (seconds < 60) return `${Math.ceil(seconds)} с`;
  return `${Math.ceil(seconds / 60)} мин`;
}

/** `retry_after_seconds` в человеческую строку; `null` — сервер не назвал срок. */
export function retryAfterText(seconds: number | null): string | null {
  const duration = retryAfterDuration(seconds);
  return duration === null ? null : `повтори через ${duration}`;
}
