/**
 * Местное время места рождения — единственная шкала для прогноза и пуша.
 *
 * «03:00 по Москве» — неверно: человек в Новосибирске получил бы прогноз
 * в 07:00. Поэтому и ночной джоб, и пуш считают час в поясе карты, а не
 * сервера. Ключ квоты «спроси карту» тоже местный: полночь там, где родился.
 */

/** Час ночной генерации и окно вокруг него. */
export const NIGHTLY_HOUR = 3;
/** Час пуша и окно вокруг него. */
export const PUSH_HOUR = 8;
/** Полуширина окна: джоб запускается раз в час, попадание ±30 минут. */
export const WINDOW_MINUTES = 30;

export interface LocalParts {
  /** `YYYY-MM-DD` по местным суткам. */
  readonly date: string;
  /** Минуты от местной полуночи, 0…1439. */
  readonly minutesOfDay: number;
}

const FORMATTERS = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat | null {
  const cached = FORMATTERS.get(timeZone);
  if (cached !== undefined) {
    return cached;
  }

  try {
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    FORMATTERS.set(timeZone, formatter);
    return formatter;
  } catch {
    // Неизвестный пояс — карту пропускаем, а не валим джоб.
    return null;
  }
}

/** Местные дата и время. `null` — пояс неизвестен/невалиден. */
export function localParts(at: Date, timeZone: string): LocalParts | null {
  const formatter = formatterFor(timeZone);
  if (formatter === null) {
    return null;
  }

  const parts = formatter.formatToParts(at);
  const value = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? '';

  // Некоторые сборки ICU отдают «24» вместо «00» для полуночи.
  const hour = Number(value('hour')) % 24;
  const minute = Number(value('minute'));

  if (Number.isNaN(hour) || Number.isNaN(minute)) {
    return null;
  }

  return {
    date: `${value('year')}-${value('month')}-${value('day')}`,
    minutesOfDay: hour * 60 + minute,
  };
}

/** Попадает ли местное время в окно `hour ± WINDOW_MINUTES`. */
export function inWindow(minutesOfDay: number, hour: number): boolean {
  const center = hour * 60;
  return Math.abs(minutesOfDay - center) <= WINDOW_MINUTES;
}

/**
 * Момент следующей местной полуночи — то, что уходит в `details.reset_at`.
 * Считаем сдвигом от текущего времени: на переходе летнего времени возможна
 * ошибка в час, для «когда снова можно» это допустимо.
 */
export function nextLocalMidnight(at: Date, timeZone: string): Date {
  const parts = localParts(at, timeZone);
  const minutesLeft = parts === null ? 24 * 60 : 24 * 60 - parts.minutesOfDay;
  return new Date(at.getTime() + minutesLeft * 60_000);
}
