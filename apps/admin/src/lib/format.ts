/*
 * Форматирование серверных значений. Никаких вычислений, которые решают деньги:
 * здесь только то, как уже посчитанное число показывается человеку.
 *
 * Правила, важные для поддержки:
 *   • `null`, `undefined` и пропущенное поле — всегда EMPTY ('—'), а не 0.
 *     «0 активаций» и «мы не знаем» — разные вещи, и путать их нельзя.
 *   • строку, которая не является датой, показываем как есть: пустой символ
 *     спрячет баг, а кривая дата — это баг, который надо увидеть.
 */

const LOCALE = 'ru-RU';

export const EMPTY = '—';

const MS_PER_HOUR = 3_600_000;
const MS_PER_MINUTE = 60_000;

const integer = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 0 });
const decimal = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 2 });

const dateTime = new Intl.DateTimeFormat(LOCALE, {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

const day = new Intl.DateTimeFormat(LOCALE, { day: '2-digit', month: '2-digit', year: 'numeric' });
const clock = new Intl.DateTimeFormat(LOCALE, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

/** Русская плюрализация: `plural(3, ['час','часа','часов']) → 'часа'`. */
export function plural(value: number, forms: readonly [string, string, string]): string {
  const abs = Math.abs(value) % 100;
  const last = abs % 10;
  if (abs > 10 && abs < 20) return forms[2];
  if (last > 1 && last < 5) return forms[1];
  if (last === 1) return forms[0];
  return forms[2];
}

function moment(iso: string | null | undefined): Date | null {
  if (iso === null || iso === undefined || iso === '') return null;
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** `2026-11-20T14:03:00Z` → `20.11.2026, 14:03` по часам браузера. */
export function formatDateTime(iso: string | null | undefined): string {
  const date = moment(iso);
  if (date) return dateTime.format(date);
  return iso === null || iso === undefined || iso === '' ? EMPTY : iso;
}

export function formatDate(iso: string | null | undefined): string {
  const date = moment(iso);
  if (date) return day.format(date);
  return iso === null || iso === undefined || iso === '' ? EMPTY : iso;
}

export function formatClock(iso: string | null | undefined): string {
  const date = moment(iso);
  if (date) return clock.format(date);
  return iso === null || iso === undefined || iso === '' ? EMPTY : iso;
}

/** Сколько часов прошло с момента. `null` — момента нет или он в будущем. */
export function hoursSince(iso: string | null | undefined, now: number): number | null {
  const date = moment(iso);
  if (!date) return null;
  const delta = now - date.getTime();
  return delta < 0 ? null : delta / MS_PER_HOUR;
}

/** `26 ч назад`, `5 мин назад`, `только что`. Для будущего — '—': время сервера и браузера расходятся, врать нечем. */
export function formatAgo(iso: string | null | undefined, now: number): string {
  const date = moment(iso);
  if (!date) return iso ? iso : EMPTY;
  const delta = now - date.getTime();
  if (delta < 0) return EMPTY;
  if (delta < MS_PER_MINUTE) return 'только что';
  if (delta < MS_PER_HOUR) {
    const minutes = Math.floor(delta / MS_PER_MINUTE);
    return `${integer.format(minutes)} ${plural(minutes, ['минуту', 'минуты', 'минут'])} назад`;
  }
  if (delta < 48 * MS_PER_HOUR) {
    const hours = Math.floor(delta / MS_PER_HOUR);
    return `${integer.format(hours)} ${plural(hours, ['час', 'часа', 'часов'])} назад`;
  }
  return `${day.format(date)} · ${clock.format(date)}`;
}

/** `26 ч` — длительность в часах с правильным окончанием. */
export function formatHours(hours: number): string {
  const rounded = Math.floor(hours);
  return `${integer.format(rounded)} ${plural(rounded, ['час', 'часа', 'часов'])}`;
}

export function formatInt(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? integer.format(value) : EMPTY;
}

/** Звёзды: только целые, разделитель — как просит локаль, единица приклеена. */
export function formatStars(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? `${integer.format(value)} ⭐` : EMPTY;
}

/**
 * Рубли. Копейки остаются, пока сумма не станет большой: `0,4 ₽` за прогноз и
 * `142,85 ₽` за сутки — это то, по чему считают бюджет LLM, и округлять их до
 * «0 ₽» и «143 ₽» нельзя. Тысячи и выше показываем целыми: там дробь уже шум.
 */
export function formatRub(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return EMPTY;
  const text = Math.abs(value) < 10_000 ? decimal.format(value) : integer.format(value);
  return `${text} ₽`;
}

/**
 * Доля с сервера: `AdminMetricsService.ratio()` отдаёт `0…1` (округление до
 * трёх знаков), поэтому здесь `0.124 → «12,4 %»`. Единица измерения в
 * контракте не описана — это вопрос бэкенду, а не догадка фронта; в `title`
 * кладётся исходное значение, чтобы спор можно было разрешить по скриншоту.
 */
export function formatRatio(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return EMPTY;
  return `${decimal.format(Math.round(value * 10_000) / 100)} %`;
}

export function formatRatioRaw(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? decimal.format(value) : EMPTY;
}

/** `3 из 10` — счётчик активаций; лимит выбран целиком — это видно без подсказки. */
export function formatUsage(used: number | null | undefined, total: number | null | undefined): string {
  if (typeof used !== 'number' || typeof total !== 'number') return EMPTY;
  return `${integer.format(used)} из ${integer.format(total)}`;
}

export function formatBool(value: boolean | null | undefined, yes = 'да', no = 'нет'): string {
  if (typeof value !== 'boolean') return EMPTY;
  return value ? yes : no;
}

/** Дата-строка для `<input type="date">` из ISO-момента; пусто — если момента нет. */
export function toDateInput(iso: string | null | undefined): string {
  const date = moment(iso);
  if (!date) return '';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'UTC',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
  return parts;
}

/** `2026-11-30` → `2026-11-30T23:59:59.000Z`: конец дня по UTC для `expires_at`. */
export function endOfDayUtc(dateInput: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateInput);
  if (!match) return null;
  const [, year, month, dayOfMonth] = match;
  const end = new Date(Date.UTC(Number(year), Number(month) - 1, Number(dayOfMonth), 23, 59, 59));
  return Number.isNaN(end.getTime()) ? null : end.toISOString();
}
