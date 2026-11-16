import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EnvValidationError, loadEnv } from '../src/config/env';

/**
 * Флаг `REPORT_BREAKER_ENABLED` (итерация 18, задача 1).
 *
 * Правило владельца: выключается **только отказ в запуске** нового разбора,
 * когда брейкер открыт. Лимит попыток, валидаторы, капы стоимости и окно
 * 30 минут остаются кодом; `reports_validation_streak` продолжает расти.
 *
 * Мусор в переменной (`true`, `2`, пусто) — падение на старте с именем
 * переменной. Флаг защиты бюджета, который «сам угадал значение», хуже
 * отсутствующего: с ним прод может молча остаться без защиты.
 */

const ROOT = join(__dirname, '../../..');
const CHECK = join(ROOT, 'check.sh');
const DEPLOY_CHECK = join(ROOT, 'scripts/deploy/check.sh');

function envWith(overrides: Readonly<Record<string, string | undefined>>): NodeJS.ProcessEnv {
  const merged: NodeJS.ProcessEnv = { ...process.env };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete merged[key];
    } else {
      merged[key] = value;
    }
  }
  return merged;
}

describe('env: REPORT_BREAKER_ENABLED', () => {
  it('по умолчанию включён', () => {
    expect(loadEnv(envWith({ REPORT_BREAKER_ENABLED: undefined })).REPORT_BREAKER_ENABLED).toBe('1');
  });

  it('явный 0 принимается: брейкер выключен только по желанию', () => {
    expect(loadEnv(envWith({ REPORT_BREAKER_ENABLED: '0' })).REPORT_BREAKER_ENABLED).toBe('0');
    expect(loadEnv(envWith({ REPORT_BREAKER_ENABLED: '1' })).REPORT_BREAKER_ENABLED).toBe('1');
  });

  it('мусор падает на старте и называет переменную', () => {
    for (const value of ['true', '2', '', 'yes', '01']) {
      let error: unknown;
      try {
        loadEnv(envWith({ REPORT_BREAKER_ENABLED: value }));
      } catch (caught) {
        error = caught;
      }

      expect(error, `значение «${value}» обязано падать`).toBeInstanceOf(EnvValidationError);
      expect((error as Error).message).toContain('REPORT_BREAKER_ENABLED');
    }
  });
});

describe('проводники флага', () => {
  it('прод-compose фиксирует 1: выключить брейкер на проде нельзя', () => {
    const prod = readFileSync(join(ROOT, 'docker-compose.prod.yml'), 'utf8');
    // Значение задано строкой и именно «1»: подстановки `${...}` здесь нет,
    // иначе `.env` стенда переопределял бы защиту на проде.
    expect(prod).toMatch(/REPORT_BREAKER_ENABLED:\s*['"]1['"]/u);
    expect(prod).not.toMatch(/REPORT_BREAKER_ENABLED:\s*\$\{/u);
  });

  it('.env.example объясняет, что 0 — только для ручных прогонов', () => {
    const example = readFileSync(join(ROOT, '.env.example'), 'utf8');
    const lines = example.split('\n');
    const index = lines.findIndex((line) => line.startsWith('REPORT_BREAKER_ENABLED='));

    expect(index).toBeGreaterThan(-1);
    // Значение по умолчанию — 1, комментарий рядом говорит про прод.
    expect(lines[index]).toBe('REPORT_BREAKER_ENABLED=1');
    const nearby = lines.slice(Math.max(0, index - 10), index + 3).join('\n');
    expect(nearby).toContain('1');
    expect(nearby.toLowerCase()).toContain('прод');
  });

  it('root check.sh --prod валит запуск на 0 и пропускает 1', () => {
    const run = (args: readonly string[], env: Readonly<Record<string, string>>) =>
      spawnSync('bash', [CHECK, ...args], {
        env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin:/usr/local/bin', ...env },
        encoding: 'utf8',
      });

    const blocked = run(['--prod'], { REPORT_BREAKER_ENABLED: '0' });
    expect(blocked.status).toBe(1);
    expect(blocked.stderr).toContain('REPORT_BREAKER_ENABLED');

    expect(run(['--prod'], { REPORT_BREAKER_ENABLED: '1' }).status).toBe(0);
    expect(run(['--prod'], {}).status).toBe(0);
    // Без --prod то же значение только предупреждает: это стенд.
    const dev = run([], { REPORT_BREAKER_ENABLED: '0' });
    expect(dev.status).toBe(0);
    expect(dev.stderr).toContain('REPORT_BREAKER_ENABLED');
  });

  it('deploy check.sh --prod читает значение из .env и валит на 0', () => {
    const base = [
      'TELEGRAM_BOT_TOKEN=000000000:qa_smoke_token_value',
      'PSEUDONYM_PEPPER=0123456789abcdef0123456789abcdef',
      'TELEGRAM_WEBHOOK_SECRET=qa_webhook_secret',
      'INTERNAL_JOB_SECRET=qa_internal_job_secret',
      'POSTGRES_PASSWORD=not-the-default-password',
      'POSTGRES_USER=astro',
      'POSTGRES_DB=astro_soul',
    ];
    const write = (extra: string): string => {
      const dir = mkdtempSync(join(tmpdir(), 'astro-soul-breaker-'));
      const file = join(dir, 'env');
      writeFileSync(file, `${[...base, extra].join('\n')}\n`);
      return file;
    };
    const run = (envFile: string) =>
      spawnSync('bash', [DEPLOY_CHECK, '--prod'], {
        env: {
          PATH: process.env['PATH'] ?? '/usr/bin:/bin:/usr/local/bin',
          ENV_FILE: envFile,
        },
        encoding: 'utf8',
      });

    const off = run(write('REPORT_BREAKER_ENABLED=0'));
    expect(off.status).toBe(1);
    expect(off.stderr).toContain('REPORT_BREAKER_ENABLED');

    expect(run(write('REPORT_BREAKER_ENABLED=1')).status).toBe(0);
    // Отсутствие переменной — не ошибка: действует дефолт кода (1).
    expect(run(write('# флага нет')).status).toBe(0);
  });
});
