/**
 * Проверка тестовой БД **до** запуска vitest (`pnpm --filter @astro-soul/api test`).
 *
 * Зачем отдельный шаг, а не только `globalSetup`: при мёртвой БД vitest успевал
 * напечатать «No test files found, exiting with code 1» вперемешку с ошибкой
 * соединения. Красный прогон без единого теста читается как «тестов нет»,
 * и это опаснее падения: молча пустой прогон можно принять за зелёный.
 *
 * Скрипт ничего не создаёт и не мигрирует — он только соединяется и честно
 * говорит, куда ходил. Пароль в вывод не попадает: в строку печатается только
 * хост, порт и имя базы.
 */
import { Client } from 'pg';
import { TEST_DATABASE_URL } from '../test/test-env';

/** `postgres://user:secret@host:port/db` → `postgres://user@host:port/db`. */
export function maskDatabaseUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.password !== '') {
      parsed.password = '';
    }
    return parsed.toString();
  } catch {
    return '<не разобрать TEST_DATABASE_URL>';
  }
}

export async function checkTestDatabase(url: string = TEST_DATABASE_URL): Promise<string | null> {
  const client = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });

  try {
    await client.connect();
    await client.query('SELECT 1');
    return null;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return (
      'тестовая БД недоступна, задайте `TEST_DATABASE_URL`\n' +
      `  куда ходили: ${maskDatabaseUrl(url)}\n` +
      `  причина: ${reason}\n` +
      '  поднимите Postgres и создайте базу: createdb astro_soul_test\n' +
      '  переменная та же, что у vitest: TEST_DATABASE_URL=postgres://user@host:5432/astro_soul_test'
    );
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function main(): Promise<void> {
  const problem = await checkTestDatabase();
  if (problem === null) {
    return;
  }

  process.stderr.write(`\n[api] ${problem}\n\n`);
  process.exitCode = 1;
}

if (process.argv[1]?.endsWith('check-test-db.ts') === true) {
  void main();
}
