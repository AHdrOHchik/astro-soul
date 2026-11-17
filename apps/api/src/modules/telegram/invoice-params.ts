/**
 * Ограничения Bot API на параметры счёта (`createInvoiceLink`).
 *
 * Зачем отдельный файл: 4 из 8 тарифов уходили в Telegram с `title` длиннее
 * 32 символов («Разбор личности — подписка на месяц» — 35). Bot API отвечает
 * на такое `400`, наш клиент превращал это в `502`, и человек видел «не удалось
 * создать счёт» вместо окна оплаты. Ошибка была невидимой: ни один тест не
 * сверял данные каталога с лимитами платформы.
 *
 * Источник лимитов — Bot API (bots/api#createinvoicelink, bots/api#labeledprice):
 *   • `title` — 1–32 **символа**;
 *   • `description` — 1–255 символов;
 *   • `payload` — 1–128 **байт**;
 *   • `prices` — для XTR ровно одна позиция, label 1–32 символа, amount — целое;
 *   • `subscription_period` — для XTR, если указан, всегда 2 592 000 секунд.
 *
 * Проверка стоит в двух местах: перед вызовом Telegram (`billing.service.ts`,
 * чтобы отказ был с внятной причиной в логе) и в `pnpm payments:diagnose`
 * (`--catalogue`), чтобы каталог можно было проверить без сети.
 * Ограничения `title`/`description` считаются по символам, а не байтам:
 * кириллица в UTF-8 занимает два байта, и проверка «по длине строки в JS»
 * здесь как раз то, что нужно.
 */

export const INVOICE_TITLE_MAX_CHARS = 32;
export const INVOICE_DESCRIPTION_MAX_CHARS = 255;
export const INVOICE_PAYLOAD_MAX_BYTES = 128;
export const INVOICE_LABEL_MAX_CHARS = 32;

/**
 * Период звёздной подписки: Bot API принимает только 30 дней.
 * Другие значения (`week_149`, `year_2990`, `test_1`) Telegram отклоняет.
 */
export const XTR_SUBSCRIPTION_PERIOD_SECONDS = 2_592_000;

export interface InvoicePriceLike {
  readonly label: string;
  readonly amount: number;
}

export interface InvoiceParamsLike {
  readonly title: string;
  readonly description: string;
  readonly payload: string;
  readonly prices: readonly InvoicePriceLike[];
  readonly subscriptionPeriod?: number;
}

export interface TelegramLimitViolation {
  /** Поле, которое не пройдёт валидацию Bot API. */
  readonly field: 'title' | 'description' | 'payload' | 'prices' | 'subscription_period';
  /** Значение и лимит — числами, без текста счёта: строка попадает в лог. */
  readonly actual: number;
  readonly limit: number;
}

function chars(value: string): number {
  return [...value].length;
}

/**
 * Что именно Telegram не примет. `null` — параметры в порядке.
 *
 * Возвращает первое нарушение, а не список: чинить всё равно данные каталога,
 * а одна понятная причина в логе полезнее пяти.
 */
export function invoiceParamsViolation(params: InvoiceParamsLike): TelegramLimitViolation | null {
  const titleLength = chars(params.title);
  if (titleLength < 1 || titleLength > INVOICE_TITLE_MAX_CHARS) {
    return { field: 'title', actual: titleLength, limit: INVOICE_TITLE_MAX_CHARS };
  }

  const descriptionLength = chars(params.description);
  if (descriptionLength < 1 || descriptionLength > INVOICE_DESCRIPTION_MAX_CHARS) {
    return { field: 'description', actual: descriptionLength, limit: INVOICE_DESCRIPTION_MAX_CHARS };
  }

  const payloadBytes = Buffer.byteLength(params.payload, 'utf8');
  if (payloadBytes < 1 || payloadBytes > INVOICE_PAYLOAD_MAX_BYTES) {
    return { field: 'payload', actual: payloadBytes, limit: INVOICE_PAYLOAD_MAX_BYTES };
  }

  // Для Telegram Stars набор позиций — ровно одна: «разбейте цену на части»
  // в звёздах платформа не поддерживает.
  if (params.prices.length !== 1) {
    return { field: 'prices', actual: params.prices.length, limit: 1 };
  }

  const price = params.prices[0];
  if (price !== undefined) {
    const labelLength = chars(price.label);
    if (labelLength < 1 || labelLength > INVOICE_LABEL_MAX_CHARS) {
      return { field: 'prices', actual: labelLength, limit: INVOICE_LABEL_MAX_CHARS };
    }
    if (!Number.isSafeInteger(price.amount) || price.amount < 1) {
      return { field: 'prices', actual: price.amount, limit: 1 };
    }
  }

  return null;
}

/**
 * Совет для периода подписки: Telegram принимает только 30 дней.
 *
 * Не отказ: решение «что делать с недельным и годовым тарифом» принимает
 * владелец (`payments.md` §3.6). Наша задача — чтобы это было видно в логе
 * (`subscription_period_unsupported`), а не выяснялось по ошибке в клиенте.
 */
export function subscriptionPeriodSupported(periodSeconds: number | null | undefined): boolean {
  // `null`/`undefined` — разовый товар: периода нет, ограничение не про него.
  return (
    periodSeconds === undefined ||
    periodSeconds === null ||
    periodSeconds === XTR_SUBSCRIPTION_PERIOD_SECONDS
  );
}
