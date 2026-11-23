/*
 * Единственное место, откуда берутся настройки окружения сборки.
 *
 * Значения живут в `.env.example` в корне репозитория (AGENTS.md §1: «единственный
 * источник»). `VITE_*` доходят до браузера, всё остальное читает только конфиг
 * Vite. Здесь нет ни одного дефолта-числа, которое могло бы подменить серверный
 * ответ: цена, право на грант и сумма возврата приходят только с API.
 */

export interface AdminConfig {
  /**
   * База адресов API. '' = тот же origin, что и у панели — это и есть выбранная
   * схема: `admin.<домен>` проксирует `/api/*` на backend без обрезки префикса.
   * Отдельный домен для API потребовал бы CORS с точным origin и `SameSite=None`,
   * и эта ветка не проверяется ни одним прогоном — поэтому её нет.
   */
  readonly apiBaseUrl: string;
  /** Версия контракта, под которую собрана панель (только для надписи в шапке). */
  readonly contractVersion: string;
  /**
   * Username бота из BotFather — нужен, чтобы отрисовать Telegram Login Widget.
   * Пусто: виджет не рисуется, экран входа говорит про отсутствующую настройку.
   * Подставлять имя бота из кода нельзя: это значение человека, а не фронтенда.
   */
  readonly botUsername: string;
  /**
   * Данные отдаёт dev-мокер. Значение подставляет `vite.config.ts` из `API_MOCK`,
   * поэтому два переключателя не могут разойтись: одна переменная — и мокер, и
   * плашка «ДЕМО». В прод-сборке всегда `false`: сборка с `API_MOCK=1` падает.
   */
  readonly demoMode: boolean;
}

const raw = import.meta.env;

function str(value: string | undefined): string {
  return (value ?? '').trim().replace(/\/+$/, '');
}

/**
 * Запасное значение версии контракта. Единственный «дефолт» в этом файле, и он
 * не про деньги: только подпись в шапке. Настоящее значение — из
 * `api.openapi.yaml`, и тест (`src/api/routes.contract.test.ts`) сверяет их,
 * чтобы надпись не отстала от контракта.
 */
const FALLBACK_CONTRACT_VERSION = '1.6.14';

export const config: AdminConfig = {
  apiBaseUrl: str(raw.VITE_API_BASE_URL as string | undefined),
  contractVersion: (raw.VITE_CONTRACT_VERSION as string | undefined) ?? FALLBACK_CONTRACT_VERSION,
  botUsername: str(raw.VITE_TG_BOT_USERNAME as string | undefined).replace(/^@/, ''),
  demoMode: raw.DEV && (raw.VITE_ADMIN_DEMO as string | undefined) === '1',
};

/** Префикс всех маршрутов: реверс-прокси отдаёт `/api/*` как есть. */
export const API_PREFIX = '/api/v1';
