/**
 * Разбор `start`-значений итерации 39 (контракт 1.6.14).
 *
 * Два новых префикса рядом с уже существующими `chart_` и `sh_`:
 *   • `pt_<code>` — партнёрская ссылка `t.me/<bot>?start=pt_<code>`; код
 *     активируется сразу, и человеку говорят, что он получил;
 *   • `ref_<short_id>` — приглашение друга.
 *
 * Функции чистые и лежат отдельно от сервисов: их проверяет тест на строковых
 * примерах, а не на базе. `pt_` в нижнем регистре — это префикс, сам код
 * набирается заглавными, поэтому нормализация кода живёт в `AccessCodesService`.
 */

/** `pt_<8 знаков>`; код приводим к верхнему регистру в сервисе кодов. */
const PARTNER_PATTERN = /^pt_([A-Za-z0-9]{4,32})$/u;

/** `chart_<uuid>` и `sh_<short>` — чужие для этого файла, но не ошибка. */
export function parsePartnerStart(value: string | undefined): string | null {
  if (value === undefined) {
    return null;
  }

  const match = PARTNER_PATTERN.exec(value.trim());
  return match?.[1] ?? null;
}

/** Вид ссылки — для логов и для текста бота. */
export type StartKind = 'partner' | 'referral' | 'chart' | 'share' | 'unknown';

export function startKind(value: string | undefined): StartKind {
  if (value === undefined) {
    return 'unknown';
  }

  const trimmed = value.trim();

  if (trimmed.startsWith('pt_')) {
    return 'partner';
  }
  if (trimmed.startsWith('ref_')) {
    return 'referral';
  }
  if (trimmed.startsWith('chart_')) {
    return 'chart';
  }
  if (trimmed.startsWith('sh_')) {
    return 'share';
  }

  return 'unknown';
}
