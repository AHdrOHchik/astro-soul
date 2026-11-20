import { Inject, Injectable } from '@nestjs/common';
import { DbService } from '../../db/db.service';
import { APP_ENV } from '../../config/env.module';
import type { AppEnv } from '../../config/env';

/**
 * Прод-гард (итерация 36, блокер Б-5).
 *
 * `check.sh --prod` проверяет те же вещи, но у него есть слепое пятно: он читает
 * **окружение**, а тестовые тарифы лежат **в БД**. Пока БД поднята, `check.sh`
 * про них не знает, то есть защита не срабатывает ровно там, где нужна — на
 * боевом сервере с боевой базой. Поэтому те же проверки повторяются на старте
 * API, где обе половины уже доступны.
 *
 * Отказ — не «предупреждение в логе»: сервис с тестовыми тарифами за 1 ⭐ и без
 * брейкера не должен принимать трафик ни секунды. Поэтому `main.ts` вызывает
 * `assertSafe()` **до** `listen` и выходит с кодом 1.
 *
 * Что проверяется в проде:
 *   • `PAYMENTS_TEST_PLANS=1` — тестовые тарифы доступны через API;
 *   • активные строки `plans` с `test_only = true` — «тестовый тариф в проде»;
 *   • `REPORT_BREAKER_ENABLED=0` — брейкер разборов выключен (массовый провал
 *     валидации жжёт бюджет на каждом заказе);
 *   • `COMPAT_BREAKER_ENABLED=0` — то же для совместимости: в `check.sh` они
 *     стоят рядом, и здесь тоже.
 *
 * В непроде не проверяется ничего: там тестовые тарифы — рабочий инструмент.
 */

/** Машинный код нарушения: по нему пишутся логи и тесты, текст — для человека. */
export type ProdGuardCode =
  | 'test_plans_flag'
  | 'test_plan_rows'
  | 'report_breaker_off'
  | 'compat_breaker_off';

export interface ProdGuardViolation {
  readonly code: ProdGuardCode;
  /** Что именно не так. Называет строку/флаг, а не «что-то не настроено». */
  readonly problem: string;
  /** Как исправить: конкретное действие, а не «посмотрите документацию». */
  readonly fix: string;
}

/** Код выхода процесса при нарушении прод-гарда. */
export const PROD_GUARD_EXIT_CODE = 1;

/**
 * Отказ старта. Наследник `Error`, чтобы `main.ts` отличал его от прочих
 * сбоев: у него свой код выхода и свой текст в лог.
 */
export class ProdGuardError extends Error {
  constructor(readonly violations: readonly ProdGuardViolation[]) {
    super(`прод-гард: ${violations.length} нарушений — ${violations.map((v) => v.code).join(', ')}`);
    this.name = 'ProdGuardError';
  }

  /** Сообщение для человека: что не так и что сделать, по пунктам. */
  report(): string {
    return this.violations
      .map((violation, index) => `${index + 1}. ${violation.problem}\n   → ${violation.fix}`)
      .join('\n');
  }
}

@Injectable()
export class ProdGuardService {
  constructor(
    @Inject(APP_ENV) private readonly env: AppEnv,
    @Inject(DbService) private readonly db: DbService,
  ) {}

  /** Прод ли это. Признак один — `NODE_ENV`, как и у всего остального кода. */
  isProduction(): boolean {
    return this.env.NODE_ENV === 'production';
  }

  /**
   * Все нарушения. Пустой массив — можно стартовать.
   *
   * Никогда не бросает: `assertSafe` — отдельный метод, потому что тестам и
   * диагностике нужен список, а процессу — отказ.
   */
  async check(): Promise<readonly ProdGuardViolation[]> {
    if (!this.isProduction()) {
      return [];
    }

    const violations: ProdGuardViolation[] = [];

    if (this.env.PAYMENTS_TEST_PLANS === '1') {
      violations.push({
        code: 'test_plans_flag',
        problem:
          'PAYMENTS_TEST_PLANS=1: тарифы test_1 (подписка) и test_report_1 (разбор) продаются за 1 ⭐ — любой, кто знает код, получает доступ бесплатно',
        fix: 'убрать PAYMENTS_TEST_PLANS из окружения процесса (docker-compose / systemd / .env прода) и перезапустить API',
      });
    }

    const rows = await this.db.query<{ code: string }>(
      `SELECT code FROM plans WHERE test_only AND is_active ORDER BY code`,
    );

    if (rows.length > 0) {
      const codes = rows.map((row) => row.code).join(', ');
      violations.push({
        code: 'test_plan_rows',
        problem: `в plans есть активные строки с test_only = true (${codes}): тариф существует только для стенда, а стоит в боевой базе`,
        fix: `UPDATE plans SET is_active = false WHERE test_only; — или удалить строки: DELETE FROM plans WHERE test_only AND code IN (${rows
          .map((row) => `'${row.code}'`)
          .join(', ')})`,
      });
    }

    if (this.env.REPORT_BREAKER_ENABLED === '0') {
      violations.push({
        code: 'report_breaker_off',
        problem:
          'REPORT_BREAKER_ENABLED=0: circuit breaker разборов выключен — трёх провалов подряд не хватит, чтобы остановить приём, и каждый заказ сжигает бюджет',
        fix: 'REPORT_BREAKER_ENABLED=1 (значение по умолчанию) — переменную лучше убрать совсем',
      });
    }

    if (this.env.COMPAT_BREAKER_ENABLED === '0') {
      violations.push({
        code: 'compat_breaker_off',
        problem:
          'COMPAT_BREAKER_ENABLED=0: circuit breaker совместимости выключен — то же самое, отдельный счётчик и отдельный флаг',
        fix: 'COMPAT_BREAKER_ENABLED=1 (значение по умолчанию) — переменную лучше убрать совсем',
      });
    }

    return violations;
  }

  /** Отказ старта: бросает `ProdGuardError`, если есть нарушения в проде. */
  async assertSafe(): Promise<void> {
    const violations = await this.check();

    if (violations.length > 0) {
      throw new ProdGuardError(violations);
    }
  }
}
