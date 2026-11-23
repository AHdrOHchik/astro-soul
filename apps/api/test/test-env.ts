import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Тестовое окружение. Реальных данных и токенов нет: значения вымышленные.
 * Файл импортируется и в globalSetup (миграции), и в setupFiles (воркеры).
 */
export const TEST_DATABASE_URL =
  process.env['TEST_DATABASE_URL'] ??
  'postgres://postgres@127.0.0.1:5432/astro_soul_test';

export const TEST_BOT_TOKEN = '123456789:TEST-TOKEN-for-unit-tests-only';
export const TEST_PEPPER = 'test-pepper-0123456789-0123456789-0123456789';
export const TEST_WEBHOOK_SECRET = 'test-webhook-secret-0123456789';

export function applyTestEnv(): void {
  process.env['NODE_ENV'] = 'test';
  process.env['DATABASE_URL'] = TEST_DATABASE_URL;
  process.env['DATABASE_POOL_MAX'] = '4';
  process.env['TELEGRAM_BOT_TOKEN'] = TEST_BOT_TOKEN;
  process.env['TELEGRAM_WEBHOOK_SECRET'] = TEST_WEBHOOK_SECRET;
  process.env['PSEUDONYM_PEPPER'] = TEST_PEPPER;
  process.env['LOG_LEVEL'] = 'error';
  process.env['APPLICATION_VERSION'] = '0.0.0-test';
  // Вымышленный контакт: тесты проверяют, что текст просит написать именно туда.
  process.env['SUPPORT_CONTACT'] = '@test_support';
  // Лимиты в тестах выключены: интеграционные сценарии делают десятки запросов.
  // Поведение самого лимитера проверяется отдельным спеком с явными значениями.
  process.env['RATE_LIMIT_PER_MIN'] = '0';
  process.env['RATE_LIMIT_CHARTS_PER_MIN'] = '0';
  process.env['RATE_LIMIT_GEO_PER_MIN'] = '0';
  process.env['GEO_PROVIDER'] = 'bundled';
  // Кнопка пуша «Открыть» ссылается на бота; без имени ссылку не построить.
  process.env['BOT_USERNAME'] = 'astro_soul_test_bot';
  // Имя продукта на карточках сторис. Вымышленное и не похоже на боевое: тесты
  // проверяют, что на картинке ровно конфиг, а не «Astro Soul по умолчанию».
  // Слова «Тест» в нём нет намеренно: старый тест «в карточке нет имени
  // человека» ищет подстроку от вымышленного `first_name` и ловил бы бренд.
  process.env['BRAND_NAME'] = 'Сонарий';
  // Приватное хранилище файлов — во временном каталоге, а не в репозитории:
  // тесты пишут PDF и карточки, и это не должно попадать в рабочее дерево.
  process.env['FILE_STORAGE_DIR'] = process.env['FILE_STORAGE_DIR'] ?? join(tmpdir(), 'astro-soul-test-files');
}

/** Вымышленный пользователь Telegram. */
export const FICTIONAL_USER = {
  id: 777_000_111,
  first_name: 'Тест',
  last_name: 'Тестов',
  username: 'test_user',
  language_code: 'ru',
} as const;
