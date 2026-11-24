import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DbService } from '../src/db/db.service';
import type { AppEnv } from '../src/config/env';
import {
  ProdGuardError,
  ProdGuardService,
  type ProdGuardViolation,
} from '../src/modules/ops/prod-guard.service';
import { createTestContext, type TestContext } from './test-app';

/**
 * Прод-гард (итерация 36, блокер Б-5).
 *
 * `check.sh --prod` читает окружение и не видит БД, а тестовый тариф за 1 ⭐
 * живёт именно в `plans`. Поэтому на старте API проверяются обе половины, и
 * отказ — это отказ старта, а не предупреждение в логе.
 *
 * Тесты делятся на два вида:
 *   • интеграционные — сервис против реальной схемы (иначе запрос к `plans`
 *     проверял бы сам себя);
 *   • юнит — синтетический `DbService`: строки `test_only` есть, а базы нет.
 */

const violationsCodes = (violations: readonly ProdGuardViolation[]): string[] =>
  violations.map((violation) => violation.code);

describe('прод-гард в production', () => {
  let ctx: TestContext;
  let guard: ProdGuardService;

  beforeAll(async () => {
    ctx = await createTestContext({
      env: {
        NODE_ENV: 'production',
        // Флаги в порядке, тестовые тарифы выключены — «чистый прод».
        PAYMENTS_TEST_PLANS: '0',
        REPORT_BREAKER_ENABLED: '1',
        COMPAT_BREAKER_ENABLED: '1',
      },
    });
    guard = ctx.app.get(ProdGuardService);

    // Состояние «чистого прода» готовим сами, а не надеемся на порядок файлов:
    // `plans` — справочник, его не чистит `truncateAll`, а другие спеки
    // (например, `plan-test-only`) создают там тестовые строки. Тест, который
    // краснеет из-за соседа, ничего не говорит о прод-гарде.
    await ctx.db.query(
      `INSERT INTO plans (code, kind, subscription_plan, stars, period_seconds, title, invoice_title,
                          description, price_label, paywall_title, paywall_subtitle, grants, sort,
                          is_active, test_only)
       VALUES ('test_1', 'subscription', 'week', 1, 604800, 'Тестовый тариф',
               'Тестовый тариф', 'Описание', '1 ⭐', 'Заголовок', 'Подзаголовок',
               '{"fullForecast":true,"askPerDay":-1,"compatPerMonth":1,"solarIncluded":true}'::jsonb,
               5, false, true),
              ('test_report_1', 'one_off', 'none', 1, NULL, 'Тестовый разбор',
               'Тестовый разбор', 'Описание', '1 ⭐', 'Заголовок', 'Подзаголовок',
               '{"report":true}'::jsonb, 6, false, true)
       ON CONFLICT (code) DO UPDATE SET test_only = true, is_active = false`,
    );
    await ctx.db.query(`UPDATE plans SET is_active = false WHERE test_only`);
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('чистый прод стартует: тестовые строки в `plans` выключены', async () => {
    await expect(guard.check()).resolves.toEqual([]);
  });

  it('активная строка test_only → отказ старта с именами строк', async () => {
    await ctx.db.query(`UPDATE plans SET is_active = true WHERE test_only`);

    try {
      const violations = await guard.check();
      expect(violationsCodes(violations)).toEqual(['test_plan_rows']);

      const [violation] = violations;
      // Сообщение называет проблему и то, как её исправить, — а не «что-то не так».
      expect(violation?.problem).toContain('test_1');
      expect(violation?.problem).toContain('test_report_1');
      expect(violation?.fix).toContain('is_active = false');

      await expect(guard.assertSafe()).rejects.toBeInstanceOf(ProdGuardError);
    } finally {
      await ctx.db.query(`UPDATE plans SET is_active = false WHERE test_only`);
    }
  });

  it('`assertSafe` отдаёт текст «что не так и как исправить» по пунктам', async () => {
    await ctx.db.query(`UPDATE plans SET is_active = true WHERE test_only`);

    try {
      const error = await guard.assertSafe().then(
        () => null,
        (caught: unknown) => caught,
      );

      expect(error).toBeInstanceOf(ProdGuardError);
      const report = (error as ProdGuardError).report();
      expect(report).toContain('test_only = true');
      expect(report).toContain('→');
      expect((error as ProdGuardError).message).toContain('test_plan_rows');
    } finally {
      await ctx.db.query(`UPDATE plans SET is_active = false WHERE test_only`);
    }
  });
});

describe('прод-гард: флаги окружения', () => {
  let ctx: TestContext;
  let guard: ProdGuardService;

  beforeAll(async () => {
    ctx = await createTestContext({
      env: {
        NODE_ENV: 'production',
        PAYMENTS_TEST_PLANS: '1',
        REPORT_BREAKER_ENABLED: '0',
        COMPAT_BREAKER_ENABLED: '0',
      },
    });
    guard = ctx.app.get(ProdGuardService);
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('тестовые тарифы, выключенные брейкеры → три нарушения сразу', async () => {
    const violations = await guard.check();

    expect(violationsCodes(violations)).toEqual([
      'test_plans_flag',
      'report_breaker_off',
      'compat_breaker_off',
    ]);

    const [flag] = violations;
    expect(flag?.problem).toContain('PAYMENTS_TEST_PLANS');
    expect(flag?.fix).toContain('убрать PAYMENTS_TEST_PLANS');
  });
});

describe('прод-гард вне прода', () => {
  it('в development те же настройки не мешают старту', async () => {
    const ctx = await createTestContext({
      env: {
        NODE_ENV: 'development',
        PAYMENTS_TEST_PLANS: '1',
        REPORT_BREAKER_ENABLED: '0',
        COMPAT_BREAKER_ENABLED: '0',
      },
    });

    try {
      // На стенде тестовый тариф — рабочий инструмент, а не авария.
      expect(ctx.app.get(ProdGuardService).isProduction()).toBe(false);
      await expect(ctx.app.get(ProdGuardService).check()).resolves.toEqual([]);
    } finally {
      await ctx.close();
    }
  });
});

describe('прод-гард: строки test_only без базы (юнит)', () => {
  it('активные строки называются по коду, неактивные не считаются', async () => {
    const env = {
      NODE_ENV: 'production',
      PAYMENTS_TEST_PLANS: undefined,
      REPORT_BREAKER_ENABLED: '1',
      COMPAT_BREAKER_ENABLED: '1',
    } as unknown as AppEnv;

    const activeDb = {
      query: () => Promise.resolve([{ code: 'test_1' }, { code: 'test_report_1' }]),
    } as unknown as DbService;

    const violations = await new ProdGuardService(env, activeDb).check();
    expect(violationsCodes(violations)).toEqual(['test_plan_rows']);
    expect(violations[0]?.problem).toContain('test_1, test_report_1');

    // Запрос фильтрует по `is_active`: выключенные строки — не нарушение,
    // иначе «исправление» из сообщения (is_active = false) ничего бы не меняло.
    const emptyDb = { query: () => Promise.resolve([]) } as unknown as DbService;
    await expect(new ProdGuardService(env, emptyDb).check()).resolves.toEqual([]);
  });
});
