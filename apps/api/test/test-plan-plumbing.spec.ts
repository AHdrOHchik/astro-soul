import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Как флаг `PAYMENTS_TEST_PLANS` доезжает до процесса.
 *
 * Тестовые тарифы за 1 ⭐ (`test_1`, `test_report_1`) включаются переменной
 * окружения; `env.ts` читает её из `process.env` и ниоткуда больше. Значит
 * мало записать строку в `.env`: у каждого способа запуска свой проводник,
 * и порванный проводник выглядит как «флаг включил, а ничего не изменилось» —
 * ровно так это и выглядело на стенде.
 *
 * Здесь проверяются оба места обрыва:
 *   1. `docker-compose.yml` — compose подставляет в контейнер только те
 *      переменные, что перечислены в `environment:` сервиса `api`;
 *   2. `scripts/deploy/check.sh --prod` — сторож на обратной стороне:
 *      теперь флаг пробрасывается, поэтому `.env` с ним обязан валить прод.
 *
 * Файлы читаются как текст, а не через YAML-парсер: `yaml` — не зависимость
 * проекта, а проверка тут про буквальную строку, которую видит compose.
 */

const ROOT = join(__dirname, '../../..');
const COMPOSE = join(ROOT, 'docker-compose.yml');
const COMPOSE_PROD = join(ROOT, 'docker-compose.prod.yml');
const ENV_EXAMPLE = join(ROOT, '.env.example');
const DEPLOY_CHECK = join(ROOT, 'scripts/deploy/check.sh');

interface RunResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Валидный prod `.env`: всё обязательное задано, опасно-стендового нет. */
const PROD_ENV_BASE = [
  'TELEGRAM_BOT_TOKEN=000000000:qa_smoke_token_value',
  'PSEUDONYM_PEPPER=0123456789abcdef0123456789abcdef',
  'TELEGRAM_WEBHOOK_SECRET=qa_webhook_secret',
  'INTERNAL_JOB_SECRET=qa_internal_job_secret',
  'POSTGRES_PASSWORD=not-the-default-password',
  'POSTGRES_USER=astro',
  'POSTGRES_DB=astro_soul',
].join('\n');

function runDeployCheck(envFile: string): RunResult {
  const result = spawnSync('bash', [DEPLOY_CHECK, '--prod'], {
    env: {
      PATH: process.env['PATH'] ?? '/usr/bin:/bin:/usr/local/bin',
      ENV_FILE: envFile,
    },
    encoding: 'utf8',
  });

  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function writeEnvFile(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'astro-soul-env-'));
  const file = join(dir, 'env');
  writeFileSync(file, body + '\n');
  return file;
}

describe('PAYMENTS_TEST_PLANS: проводник до контейнера', () => {
  it('compose передаёт флаг в api, по умолчанию — пусто', () => {
    const compose = readFileSync(COMPOSE, 'utf8');

    // Именно эта запись: пустое значение по умолчанию (флаг выключен) и
    // подстановка из .env (иначе строка в .env ничего не включает).
    expect(compose).toContain('PAYMENTS_TEST_PLANS: ${PAYMENTS_TEST_PLANS:-}');
  });

  it('флаг не подсказывается в .env.example и не включается в prod-оверлее', () => {
    expect(readFileSync(ENV_EXAMPLE, 'utf8')).not.toContain('PAYMENTS_TEST_PLANS');

    const prod = readFileSync(COMPOSE_PROD, 'utf8');
    expect(prod).not.toContain('PAYMENTS_TEST_PLANS=1');
    expect(prod).not.toContain('PAYMENTS_TEST_PLANS: 1');
  });

  it('prod-проверка валит .env с флагом и называет оба тарифа', () => {
    const envFile = writeEnvFile(`${PROD_ENV_BASE}\nPAYMENTS_TEST_PLANS=1`);
    const result = runDeployCheck(envFile);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('PAYMENTS_TEST_PLANS');
    // Один флаг — два денежных пути: сообщение должно называть оба.
    expect(result.stderr).toContain('test_1');
    expect(result.stderr).toContain('test_report_1');
  });

  it('prod-проверка ловит и выключенное значение: строка с флагом в .env — ошибка', () => {
    const envFile = writeEnvFile(`${PROD_ENV_BASE}\nPAYMENTS_TEST_PLANS=0`);
    const result = runDeployCheck(envFile);

    // `0` безопасно само по себе, но такая строка означает, что на стенде он
    // включался, и в проде ей нечего делать: следующий человек поставит `1`.
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('PAYMENTS_TEST_PLANS');
  });

  it('чистый prod .env проходит проверку', () => {
    const envFile = writeEnvFile(PROD_ENV_BASE);
    const result = runDeployCheck(envFile);

    expect(result.stderr).not.toContain('PAYMENTS_TEST_PLANS');
    expect(result.status).toBe(0);
  });
});
