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
