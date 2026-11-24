/**
 * Секрет в пути и в адресе вебхука (Б-4, итерация 45).
 *
 * `TELEGRAM_WEBHOOK_SECRET` — не заголовок и не query, а **сегмент пути**:
 * `/api/v1/internal/telegram/webhook/<secret>`. Поэтому он попадает во всё, что
 * пишет путь или адрес: access-лог nginx (`$uri`), access-лог API
 * (`http_request.path`), логи переустановки вебхука (`url`, `expected_url`,
 * `actual_url`), аудит админки. Секрет в логе — это не «шум», а ключ, которым
 * можно слать боту поддельные апдейты (`pre_checkout_query` в том числе).
 *
 * Маскирование живёт здесь, а не в вызывающих местах, и применяется:
 *   • к путям — `maskSecretPath` (внутри `requestPath`, то есть на каждый запрос);
 *   • к адресам — `maskWebhookUrl` (в логах и аудите админки);
 *   • к любым строкам лога — `maskSecrets` (внутри `redact`/`serialize` логгера).
 *
 * Последняя линия важнее двух первых: она не зависит от того, вспомнил ли автор
 * нового `logger.info(...)` про маскирование. Маска — `***`, без «последних
 * четырёх символов»: хвост секрета — это тоже секрет, а отличить «наш секрет»
 * от «чужого» умеет состояние вебхука (`ok`/`mismatch`), а не лог.
 */

/** Префикс маршрута вебхука — единственное место, где он записан в коде. */
export const TELEGRAM_WEBHOOK_PATH = '/api/v1/internal/telegram/webhook';

/** Чем заменяется секрет. Непустая строка, чтобы «поле было» читалось в логе. */
export const MASK = '***';

/**
 * Путь без секрета: `/api/v1/internal/telegram/webhook/***`.
 *
 * Маскируется только сегмент сразу после префикса — остальные пути
 * возвращаются как есть, иначе лог перестал бы отвечать на «куда шёл запрос».
 */
export function maskSecretPath(path: string): string {
  if (!path.startsWith(`${TELEGRAM_WEBHOOK_PATH}/`)) {
    return path;
  }

  const rest = path.slice(TELEGRAM_WEBHOOK_PATH.length + 1);
  const [secret] = rest.split('/');

  return secret === undefined || secret === ''
    ? `${TELEGRAM_WEBHOOK_PATH}/${MASK}`
    : `${TELEGRAM_WEBHOOK_PATH}/${MASK}${rest.slice(secret.length)}`;
}

/**
 * Адрес вебхука без секрета: `https://host/api/v1/internal/telegram/webhook/***`.
 *
 * Работает и с `null`: адрес может быть не задан (`webhook_url_not_configured`),
 * и тогда в лог идёт `null`, а не «пустая строка», которая читается как
 * «адрес есть, но странный».
 */
export function maskWebhookUrl(url: string | null | undefined): string | null {
  if (url === null || url === undefined || url === '') {
    return null;
  }

  const prefixAt = url.indexOf(TELEGRAM_WEBHOOK_PATH);

  if (prefixAt < 0) {
    return url;
  }

  const head = url.slice(0, prefixAt + TELEGRAM_WEBHOOK_PATH.length);
  const tail = url.slice(prefixAt + TELEGRAM_WEBHOOK_PATH.length);
  const [secret, ...rest] = tail.replace(/^\//u, '').split('/');

  if (secret === undefined || secret === '') {
    return url;
  }

  return `${head}/${MASK}${rest.length === 0 ? '' : `/${rest.join('/')}`}`;
}

/**
 * Вырезает секрет вебхука из произвольной строки.
 *
 * Две проверки, потому что у них разные слепые зоны:
 *   1) по форме адреса/пути — ловит `url`, `path`, текст ошибки, склейки вида
 *      `GET /api/v1/internal/telegram/webhook/<secret>`;
 *   2) по значению `TELEGRAM_WEBHOOK_SECRET` из окружения — ловит случай, когда
 *      секрет залогировали отдельным полем («secret»: «...»), а не в адресе.
 *
 * Значение читается из `process.env` лениво: логгер не должен зависеть от
 * `AppEnv`, иначе маскирование отключилось бы там, где env не прокинут.
 */
export function maskSecrets(value: string): string {
  const maskedByShape = maskWebhookUrl(value) ?? value;
  const secret = process.env['TELEGRAM_WEBHOOK_SECRET'];

  if (secret === undefined || secret.length < 8) {
    return maskedByShape;
  }

  return maskedByShape.split(secret).join(MASK);
}
