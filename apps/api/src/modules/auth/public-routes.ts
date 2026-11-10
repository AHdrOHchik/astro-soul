/**
 * Пути, доступные без initData.
 *
 * Правило: middleware на всех `/api/v1/*`, кроме `/health`.
 * У маршрутов ниже в контракте `security: []`, но своя защита:
 *   - /api/v1/charts/{id}/wheel.svg и wheel.png — подписанный `?sig=` (HMAC, TTL 30 дней);
 *   - /api/v1/internal/telegram/webhook/{secret} — секрет в пути + заголовок
 *     X-Telegram-Bot-Api-Secret-Token (следующая итерация).
 * Список закрытый: добавление маршрута без проверки — ошибка ревью.
 */
const PUBLIC_PATHS: ReadonlySet<string> = new Set(['/api/v1/health', '/health']);

/** Колесо карты: доступ даёт подпись, а не сессия. */
const WHEEL_SVG_PATH = /^\/api\/v1\/charts\/[^/]+\/wheel\.svg$/;

/** PNG колеса для шаринга: тоже по подписи (картинку вставляет Telegram). */
const WHEEL_PNG_PATH = /^\/api\/v1\/charts\/[^/]+\/wheel\.png$/;

/** Вебхук Telegram: секрет в пути + заголовок, проверка внутри обработчика. */
const TELEGRAM_WEBHOOK_PATH = /^\/api\/v1\/internal\/telegram\/webhook\/[^/]+$/;

export function isPublicPath(requestPath: string): boolean {
  const normalized = requestPath.length > 1 ? requestPath.replace(/\/+$/, '') : requestPath;
  return (
    PUBLIC_PATHS.has(normalized) ||
    WHEEL_SVG_PATH.test(normalized) ||
    WHEEL_PNG_PATH.test(normalized) ||
    TELEGRAM_WEBHOOK_PATH.test(normalized)
  );
}
