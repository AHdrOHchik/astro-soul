import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Как флаг `REFUND_ON_REPORT_FAILED` доезжает до процесса.
 *
 * Автовозврат за провал разбора выключен по умолчанию (решение владельца
 * 2026-11-16). Значит, мало иметь рабочий код возврата: нужно, чтобы флаг
 * вообще мог включиться там, где это решат, и чтобы деплой не включал его
 * случайно. `PAYMENTS_TEST_PLANS` однажды не доехал до контейнера — «включил, а
 * ничего не изменилось»; второй флаг не должен повторить этот путь.
 */
const ROOT = join(__dirname, '../../..');
const COMPOSE = join(ROOT, 'docker-compose.yml');
const COMPOSE_PROD = join(ROOT, 'docker-compose.prod.yml');
const ENV_EXAMPLE = join(ROOT, '.env.example');

describe('REFUND_ON_REPORT_FAILED: проводник и умолчание', () => {
  it('compose передаёт флаг в api, по умолчанию — пусто', () => {
    const compose = readFileSync(COMPOSE, 'utf8');

    expect(compose).toContain('REFUND_ON_REPORT_FAILED: ${REFUND_ON_REPORT_FAILED:-}');
  });

  it('флага нет в .env.example: деплой не подсказывает автовозврат', () => {
    expect(readFileSync(ENV_EXAMPLE, 'utf8')).not.toContain('REFUND_ON_REPORT_FAILED');
  });

  it('prod-оверлей не включает флаг', () => {
    const prod = readFileSync(COMPOSE_PROD, 'utf8');

    expect(prod).not.toContain('REFUND_ON_REPORT_FAILED=1');
    expect(prod).not.toContain('REFUND_ON_REPORT_FAILED: 1');
  });
});
