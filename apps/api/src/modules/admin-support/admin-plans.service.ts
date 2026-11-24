import { Inject, Injectable } from '@nestjs/common';
import { isFounderPlanCode } from '@astro-soul/shared';
import { conflict, forbidden, notFound, reasonOptions } from '../../common/api-error';
import { JsonLogger } from '../../common/logger';
import { DbService } from '../../db/db.service';
import { AdminAuditService } from '../admin-audit/admin-audit.service';
import { assertAdmin, type AdminActor } from '../admin-auth/admin-actor';
import { APP_ENV } from '../../config/env.module';
import type { AppEnv } from '../../config/env';
import { AdminPlansRepository, type PlanRecord, type PriceHistoryRow } from './admin-plans.repository';
import { parseAdminPriceUpdate } from './admin-support.dto';

/** Тариф в панели: цена, период и признаки. */
export interface AdminPlan {
  readonly code: string;
  readonly kind: 'one_off' | 'subscription';
  readonly title: string;
  readonly price_stars: number;
  /**
   * Период в днях, а не в секундах: панель показывает «30 дней», и вторая
   * единица измерения в UI — повод ошибиться на множитель 86400. В БД период
   * остаётся `period_seconds` (источник правды для `createInvoiceLink`).
   */
  readonly period_days: number | null;
  /** `test_only` как есть: псевдоним `is_test` запрещён — панель читает то же имя. */
  readonly test_only: boolean;
  readonly active: boolean;
  readonly founder_only: boolean;
  readonly version: number;
  readonly updated_at: string;
}

export interface AdminPlanPage {
  readonly items: readonly AdminPlan[];
}

export interface AdminPlanHistoryEntry {
  readonly id: string;
  readonly plan_code: string;
  readonly price_stars: number;
  readonly previous_price_stars: number | null;
  readonly version: number;
  readonly comment: string;
  readonly actor_tg_id: string;
  readonly actor_name: string;
  readonly effective_from: string;
  readonly created_at: string;
}

export interface AdminPriceUpdateResult {
  readonly plan: AdminPlan;
  readonly effective_from: string;
}

/**
 * Цены тарифов в админке (контракт 1.6.16).
 *
 * Почему `founder_month` закрыт отдельно: это тариф «первых 50», и его цена —
 * часть обещания, данного людям. Опечатка в панели (399 вместо 199) здесь
 * стоила бы не «дороже», а «мы не выполнили обещание», поэтому смена цены
 * запрещена на сервере — `403 founder_plan_locked`, — а не спрятана в UI.
 * Список берётся из `FOUNDER_PLAN_CODES` (`packages/shared`), а не сравнением
 * строки в коде: закрытый список кодов уже есть, и второй источник правды о
 * том, что такое «тариф основателей», не нужен.
 *
 * Каждое изменение цены — аудит в той же транзакции, что и `UPDATE plans`
 * (нет записи — нет новой цены) плюс строка истории с комментарием владельца.
 */
@Injectable()
export class AdminPlansService {
  constructor(
    @Inject(AdminPlansRepository) private readonly repo: AdminPlansRepository,
    @Inject(AdminAuditService) private readonly audit: AdminAuditService,
    @Inject(DbService) private readonly db: DbService,
    @Inject(APP_ENV) private readonly env: AppEnv,
    @Inject(JsonLogger) private readonly logger: JsonLogger,
  ) {}

  private ensureAdmin(actor: AdminActor, action: string): void {
    assertAdmin(actor, this.env.ADMIN_TG_ID);
    void action;
  }

  private toPlan(row: PlanRecord): AdminPlan {
    return {
      code: row.code,
      kind: row.kind,
      title: row.title,
      price_stars: row.stars,
      period_days:
        row.period_seconds === null ? null : Math.round(row.period_seconds / 86_400),
      test_only: row.test_only,
      active: row.is_active,
      founder_only: isFounderPlanCode(row.code),
      version: row.version,
      updated_at: row.updated_at.toISOString(),
    };
  }

  async list(actor: AdminActor): Promise<AdminPlanPage> {
    this.ensureAdmin(actor, 'plan.list');
    const rows = await this.repo.list();
    return { items: rows.map((row) => this.toPlan(row)) };
  }

  /**
   * `PATCH /admin/plans/{code}`.
   *
   * `409 price_changed` — версия в запросе не та: панель пришла со старой
   * вкладки. В `details.current` лежит актуальная пара «цена + версия», чтобы
   * UI мог перерисоваться, а не заставлял владельца гадать.
   */
  async updatePrice(actor: AdminActor, code: string, body: unknown): Promise<AdminPriceUpdateResult> {
    this.ensureAdmin(actor, 'plan.price_change');

    if (isFounderPlanCode(code)) {
      this.logger.warn('admin_plan_locked', { code, reason: 'founder_plan' });
      throw forbidden(
        reasonOptions(
          'founder_plan_locked',
          'Цена тарифа основателей зафиксирована: её нельзя менять из панели',
        ),
      );
    }

    const input = parseAdminPriceUpdate(body);

    const outcome = await this.db.withTransaction(async (client) => {
      const result = await this.repo.updatePrice(client, {
        code,
        priceStars: input.priceStars,
        comment: input.comment,
        baseVersion: input.baseVersion,
        actorTgId: actor.tgId,
        actorName: actor.name,
      });

      if (result === null || result === 'version_mismatch') {
        return result;
      }

      await this.audit.write(client, actor, {
        action: 'plan.price_change',
        entity: 'plan',
        entityId: result.plan.code,
        // Только изменённые поля: ни `grants`, ни `subscription_plan` в журнал
        // не попадают — их эта ручка не трогает.
        before: { price_stars: result.previousStars, version: input.baseVersion },
        after: { price_stars: result.plan.stars, version: result.plan.version },
        reason: input.comment,
      });

      return result;
    });

    if (outcome === null) {
      throw notFound(reasonOptions('plan_not_found', 'Такого тарифа нет'));
    }

    if (outcome === 'version_mismatch') {
      const current = await this.repo.get(code);
      this.logger.warn('admin_price_changed_conflict', {
        code,
        base_version: input.baseVersion,
        current_version: current?.version ?? null,
      });
      throw conflict({
        ...reasonOptions('price_changed', 'Цену уже изменили в другой вкладке'),
        details: {
          reason: 'price_changed',
          current: {
            price_stars: current?.stars ?? null,
            version: current?.version ?? null,
          },
        },
      });
    }

    this.logger.info('admin_plan_price_changed', {
      code,
      price_stars: outcome.plan.stars,
      previous_price_stars: outcome.previousStars,
      version: outcome.plan.version,
    });

    return {
      plan: this.toPlan(outcome.plan),
      // Только новые покупки: снимок цены уже выставленных счетов не меняется,
      // поэтому моментом действия цены служит момент изменения.
      effective_from: outcome.effectiveFrom.toISOString(),
    };
  }

  async history(actor: AdminActor, code: string): Promise<{ readonly items: readonly AdminPlanHistoryEntry[] }> {
    this.ensureAdmin(actor, 'plan.history');
    const rows = await this.repo.history(code);

    if (rows === null) {
      throw notFound(reasonOptions('plan_not_found', 'Такого тарифа нет'));
    }

    return { items: rows.map((row) => this.toHistoryEntry(row)) };
  }

  private toHistoryEntry(row: PriceHistoryRow): AdminPlanHistoryEntry {
    return {
      id: row.id,
      plan_code: row.plan_code,
      price_stars: row.price_stars,
      previous_price_stars: row.previous_price_stars,
      version: row.version,
      comment: row.comment,
      actor_tg_id: row.actor_tg_id,
      actor_name: row.actor_name,
      effective_from: row.effective_from.toISOString(),
      created_at: row.created_at.toISOString(),
    };
  }
}
