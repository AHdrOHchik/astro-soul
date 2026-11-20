/**
 * Ссылки шаринга и возврата в мини-апп (контракт 1.4.0, `x-bot`).
 *
 * Шаблон контракта: `https://t.me/{username}?startapp=chart_{chart_id}` —
 * именно его бот показывает в кнопке «поделиться». `username` берётся из
 * `BOT_USERNAME`, а не из запроса: иначе клиент мог бы подсунуть чужого бота.
 */

/** `chart_<uuid>` — значение `startapp`, которое Telegram отдаёт мини-аппу. */
export const STARTAPP_CHART_PREFIX = 'chart_';

export function buildStartAppValue(chartId: string): string {
  return `${STARTAPP_CHART_PREFIX}${chartId}`;
}

/**
 * Ссылка на бота с параметром карты. `null`, если имя бота не настроено:
 * врать про ссылку, которая не откроется, хуже, чем не дать её вовсе.
 */
export function buildShareLink(botUsername: string | undefined, chartId: string): string | null {
  if (botUsername === undefined || botUsername === '') {
    return null;
  }

  return `https://t.me/${botUsername}?startapp=${buildStartAppValue(chartId)}`;
}

/** Прямой адрес мини-аппа с тем же `startapp` — для кнопки в чате бота. */
export function buildMiniAppUrl(miniAppUrl: string | undefined, chartId: string): string | null {
  if (miniAppUrl === undefined || miniAppUrl === '') {
    return null;
  }

  const url = new URL(miniAppUrl);
  url.searchParams.set('startapp', buildStartAppValue(chartId));
  return url.toString();
}

/**
 * `sh_<short_id>` — метка карточки шеринга (контракт 1.6.8).
 *
 * Отдельный префикс, а не `chart_`: по ссылке `t.me/<bot>?start=sh_…` бот
 * показывает карточку, которую человек переслал, а не чужую карту. `short_id`
 * выводится из хеша содержимого карточки, поэтому ни `user_id`, ни `report_id`
 * в ссылку не попадают.
 */
export const SHARE_START_PREFIX = 'sh_';

/**
 * Алфавит `short_id` — без `0`, `1`, `o`, `l`: метку диктуют голосом и
 * перепечатывают руками, а эти символы читаются неоднозначно.
 */
const SHORT_ID_PATTERN = /^[abcdefghijkmnpqrstuvwxyz23456789]{10}$/u;

/**
 * Ссылка на бота с карточкой: `https://t.me/<bot>?start=sh_<short_id>`.
 *
 * `null` без имени бота — по той же причине, что и у карты: битая ссылка хуже
 * отсутствующей.
 */
export function buildShareCardLink(
  botUsername: string | undefined,
  shortId: string,
): string | null {
  if (botUsername === undefined || botUsername === '') {
    return null;
  }

  return `https://t.me/${botUsername}?start=${SHARE_START_PREFIX}${shortId}`;
}

/**
 * Разбор `/start sh_<short_id>`.
 *
 * Возвращает `short_id`, если метка похожа на нашу: только буквы и цифры из
 * алфавита `shortIdOf`, ровно 10 символов. Всё остальное (в том числе
 * `chart_…`) — `null`: обработчик карты по-прежнему получает свой префикс.
 */
export function parseStartShareShortId(text: string | undefined): string | null {
  if (text === undefined) {
    return null;
  }

  const parts = text.trim().split(/\s+/);
  if (parts[0] !== '/start' || parts.length !== 2) {
    return null;
  }

  const value = parts[1] ?? '';
  if (!value.startsWith(SHARE_START_PREFIX)) {
    return null;
  }

  const shortId = value.slice(SHARE_START_PREFIX.length);
  return SHORT_ID_PATTERN.test(shortId) ? shortId : null;
}

/**
 * `short_id` из текста inline-запроса (контракт 1.6.9).
 *
 * `switchInlineQuery` присылает боту то, что человек набрал после `@bot` — а
 * это может быть что угодно. Принимаем три вида, которые действительно
 * встречаются:
 *   • `k7m2p9x4qz` — сам `short_id` (человек скопировал подвал карточки);
 *   • `sh_k7m2p9x4qz` — метка из ссылки;
 *   • `https://t.me/<bot>?start=sh_k7m2p9x4qz` — ссылка целиком, вставленная
 *     из буфера обмена.
 *
 * `null` — если метки нет: пустой inline-запрос не ошибка, бот просто ничего
 * не предлагает. Чужие `start`-метки (`ref_123`) тоже не наши.
 */
export function parseInlineQueryShortId(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed === '') {
    return null;
  }

  const withPrefix = (value: string): string | null => {
    if (value.startsWith(SHARE_START_PREFIX)) {
      const shortId = value.slice(SHARE_START_PREFIX.length);
      return SHORT_ID_PATTERN.test(shortId) ? shortId : null;
    }
    return SHORT_ID_PATTERN.test(value) ? value : null;
  };

  const direct = withPrefix(trimmed);
  if (direct !== null) {
    return direct;
  }

  // Ссылка целиком: параметр `start` берём как есть, без разбора хоста —
  // имя бота в ссылке уже проверено подписью в `/start`-обработчике, а здесь
  // важен только `short_id`.
  const match = /[?&]start=([^&\s#]+)/u.exec(trimmed);
  if (match === null) {
    return null;
  }

  return withPrefix(decodeURIComponent(match[1] ?? ''));
}

/**
 * Разбор `/start chart_<id>`.
 *
 * Возвращает `chartId`, если параметр похож на UUID, иначе `null`: чужие
 * `startapp` (например, `ref_123`) бот не должен трактовать как карту.
 */
export function parseStartChartId(text: string | undefined): string | null {
  if (text === undefined) {
    return null;
  }

  const parts = text.trim().split(/\s+/);
  if (parts[0] !== '/start' || parts.length !== 2) {
    return null;
  }

  const value = parts[1] ?? '';
  if (!value.startsWith(STARTAPP_CHART_PREFIX)) {
    return null;
  }

  const chartId = value.slice(STARTAPP_CHART_PREFIX.length);
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  return uuid.test(chartId) ? chartId : null;
}
