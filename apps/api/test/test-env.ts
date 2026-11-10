/**
 * Тестовое окружение. Реальных данных и токенов нет: значения вымышленные.
 * Файл импортируется и в globalSetup (миграции), и в setupFiles (воркеры).
 */
export const TEST_DATABASE_URL =
  process.env['TEST_DATABASE_URL'] ??
  'postgres://postgres@127.0.0.1:5432/astro_soul_test';

export const TEST_BOT_TOKEN = '123456789:TEST-TOKEN-for-unit-tests-only';
export const TEST_PEPPER = 'test-pepper-0123456789-0123456789-0123456789';

export function applyTestEnv(): void {
  process.env['NODE_ENV'] = 'test';
  process.env['DATABASE_URL'] = TEST_DATABASE_URL;
  process.env['DATABASE_POOL_MAX'] = '4';
  process.env['TELEGRAM_BOT_TOKEN'] = TEST_BOT_TOKEN;
  process.env['PSEUDONYM_PEPPER'] = TEST_PEPPER;
  process.env['LOG_LEVEL'] = 'error';
  process.env['APPLICATION_VERSION'] = '0.0.0-test';
}

/** Вымышленный пользователь Telegram. */
export const FICTIONAL_USER = {
  id: 777_000_111,
  first_name: 'Тест',
  last_name: 'Тестов',
  username: 'test_user',
  language_code: 'ru',
} as const;
