import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { ApiError, reasonOptions } from '../../common/api-error';
import { JsonLogger } from '../../common/logger';
import { DbService } from '../../db/db.service';
import { APP_ENV } from '../../config/env.module';
import type { AppEnv } from '../../config/env';

/**
 * Бюджет бесплатного доступа (итерация 39).
 *
 * Зачем: грант — это подарок за счёт продукта, а не «бесплатно». Месяц доступа
 * стоит ~150 ₽ себестоимости (30 дней × 5 ₽), пятьдесят основателей — 7 500 ₽.
 * Без потолка один партнёр с кодом на 1 000 активаций уносит LLM-бюджет молча,
 * и узнаётся это из счёта провайдера.
 *
 * Что именно считается (и чего в расчёте нет):
 *   • дни **выданных** прав «всё включено» в текущем календарном месяце ×
 *     дневная себестоимость. Дни, подаренные в прошлом месяце, повторно не
 *     считаются: бюджет — про новые обещания, а не про уже данные;
 *   • **израсходованные** одноразовые права в этом месяце (разбор — по потолку
 *     разбора, совместимость — по своему). Неизрасходованные не считаются:
 *     право, которое человек не потратил, денег не стоило.
 *
 * Правило поведения: исчерпанный бюджет отказывает только в **новых** грантах
 * (`503 bonus_budget_exhausted`) и никогда не отзывает уже выданные. Иначе
 * человек терял бы оплаченный (пусть и подаренный) доступ из-за чужих подарков.
 */
export interface BonusBudgetState {
  readonly spent_rub: number;
  readonly limit_rub: number;
  readonly exhausted: boolean;
}

@Injectable()
export class BonusBudgetService {
  constructor(
    @Inject(DbService) private readonly db: DbService,
    @Inject(APP_ENV) private readonly env: AppEnv,
    @Inject(JsonLogger) private readonly logger: JsonLogger,
  ) {}

  /**
   * `client` — транзакция вызывающего (активация кода, выдача из панели).
   *
   * Считать бюджет через пул **внутри** чужой транзакции нельзя: на
   * однопоточном Postgres (PGlite в тестах, любой деплой с одной сессией) это
   * взаимная блокировка, а на обычном — чтение мимо транзакции, то есть бюджет
   * считается без ещё не закоммиченных выдач этой же транзакции. Ровно на этом
   * висела успешная активация кода (`POST /me/activate-code`).
   */
  async state(client?: PoolClient): Promise<BonusBudgetState> {
    const sql = `SELECT
         COALESCE(SUM(CASE WHEN kind = 'all_access' THEN COALESCE(days, 0) ELSE 0 END), 0)::int AS days,
         COALESCE(SUM(CASE WHEN kind = 'single_report' AND consumed_at IS NOT NULL THEN 1 ELSE 0 END), 0)::int
           AS reports,
         COALESCE(SUM(CASE WHEN kind = 'single_compat' AND consumed_at IS NOT NULL THEN 1 ELSE 0 END), 0)::int
           AS compats
         FROM grants
        WHERE created_at >= date_trunc('month', now())
          AND revoked_at IS NULL`;

    const row =
      client === undefined
        ? await this.db.queryOne<{ days: number; reports: number; compats: number }>(sql, [])
        : ((await client.query<{ days: number; reports: number; compats: number }>(sql)).rows[0] ??
          null);

    const days = row?.days ?? 0;
    const reports = row?.reports ?? 0;
    const compats = row?.compats ?? 0;

    const spent =
      days * this.env.BONUS_DAY_COST_RUB +
      reports * this.env.BONUS_REPORT_COST_RUB +
      compats * this.env.LLM_COMPAT_CAP_RUB;

    const limit = this.env.BONUS_BUDGET_RUB;
    // Округление до рубля: бюджет — управленческое число, копейки в нём создают
    // ложную точность и «мигающий» `exhausted` на границе.
    const spentRub = Math.round(spent);

    return { spent_rub: spentRub, limit_rub: limit, exhausted: spentRub >= limit };
  }

  /**
   * Проверка перед выдачей. Бросает `503 bonus_budget_exhausted` — тот же код,
   * что у LLM-капов: это «временная нехватка ресурса», а не «права нет».
   */
  async ensureAvailable(reason: string, client?: PoolClient): Promise<void> {
    const state = await this.state(client);

    if (!state.exhausted) {
      return;
    }

    this.logger.warn('bonus_budget_exhausted', {
      spent_rub: state.spent_rub,
      limit_rub: state.limit_rub,
      reason,
    });

    throw new ApiError('BONUS_BUDGET_EXHAUSTED', 503, {
      message: 'Бесплатный доступ на этот месяц закончился — попробуй в следующем',
      ...reasonOptions('bonus_budget_exhausted'),
      details: {
        reason: 'bonus_budget_exhausted',
        spent_rub: state.spent_rub,
        limit_rub: state.limit_rub,
      },
    });
  }
}
