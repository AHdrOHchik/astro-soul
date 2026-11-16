import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

/**
 * `check.sh --prod` — предполётная проверка окружения.
 *
 * Здесь проверяется сам скрипт, а не сервис: окружение для него собирается
 * с нуля (никаких унаследованных переменных), иначе `RATE_LIMIT_*=0` из
 * тестового окружения делал бы каждый запуск «плохим» и тест ничего бы не
 * доказывал.
 */

const SCRIPT = join(__dirname, '../../../check.sh');

interface RunResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function run(args: readonly string[], env: Readonly<Record<string, string>> = {}): RunResult {
  const result = spawnSync('bash', [SCRIPT, ...args], {
    env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin:/usr/local/bin', ...env },
    encoding: 'utf8',
  });

  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe('check.sh --prod', () => {
  it('чистое окружение пропускает', () => {
    const result = run(['--prod']);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  it('PAYMENTS_TEST_PLANS=1 блокирует запуск и называет переменную', () => {
    const result = run(['--prod'], { PAYMENTS_TEST_PLANS: '1' });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('PAYMENTS_TEST_PLANS');
    // Текст объясняет, чем это плохо, а не только «нельзя».
    expect(result.stderr).toContain('test_1');
  });

  it('без --prod то же окружение только предупреждает', () => {
    const result = run([], { PAYMENTS_TEST_PLANS: '1' });

    expect(result.status).toBe(0);
    expect(result.stderr).toContain('PAYMENTS_TEST_PLANS');
  });

  it('PAYMENTS_TEST_PLANS=0 — обычное выключенное значение, не блокирует', () => {
    expect(run(['--prod'], { PAYMENTS_TEST_PLANS: '0' }).status).toBe(0);
  });

  it('подменённый Bot API блокирует', () => {
    const result = run(['--prod'], { TELEGRAM_API_BASE_URL: 'http://127.0.0.1:8091' });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('TELEGRAM_API_BASE_URL');
  });

  it('настоящий Bot API не блокирует (в том числе со слэшем на конце)', () => {
    expect(run(['--prod'], { TELEGRAM_API_BASE_URL: 'https://api.telegram.org' }).status).toBe(0);
    expect(run(['--prod'], { TELEGRAM_API_BASE_URL: 'https://api.telegram.org/' }).status).toBe(0);
  });

  it('подставной LLM и выключенные лимиты блокируют', () => {
    const fake = run(['--prod'], { LLM_FAKE: '1' });
    expect(fake.status).toBe(1);
    expect(fake.stderr).toContain('LLM_FAKE');

    const limits = run(['--prod'], { RATE_LIMIT_PER_MIN: '0' });
    expect(limits.status).toBe(1);
    expect(limits.stderr).toContain('RATE_LIMIT_PER_MIN');
  });

  it('несколько проблем перечисляются все, код выхода всё равно 1', () => {
    const result = run(['--prod'], {
      PAYMENTS_TEST_PLANS: '1',
      TELEGRAM_API_BASE_URL: 'http://127.0.0.1:8091',
      LLM_FAKE: '1',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('PAYMENTS_TEST_PLANS');
    expect(result.stderr).toContain('TELEGRAM_API_BASE_URL');
    expect(result.stderr).toContain('LLM_FAKE');
  });

  it('неизвестный аргумент — код 2, а не «молча пропустили»', () => {
    expect(run(['--prodd']).status).toBe(2);
  });
});
