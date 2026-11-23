import { Inject, Injectable } from '@nestjs/common';
import type { GrantKind, GrantSource } from '@astro-soul/shared';
import { notFound, reasonOptions } from '../../common/api-error';
import { JsonLogger } from '../../common/logger';
import { DbService } from '../../db/db.service';
import { BonusBudgetService } from './bonus-budget.service';
import { GrantsRepository, type GrantRow } from './grants.repository';

/**
 * Выдача и отзыв бесплатного доступа (итерация 39, контракт 1.6.14).
 *
 * Три правила, которые держит этот сервис:
 *   1. **Срок начинается с карты.** Право можно активировать до онбординга, но
 *      дни начинают течь только когда карта построена: иначе человек «сжигает»
 *      подаренный месяц, глядя на экран ввода даты рождения. Поэтому выдача без
 *      карты создаёт ожидающую строку (`starts_at IS NULL`), а `POST /charts`
 *      запускает её через `startPending`.
 *   2. **Повторная выдача продлевает, а не дублирует.** Одно неотозванное право
 *      `all_access` на человека — этого требует уникальный индекс; второе
 *      приглашение добавляет дни к текущему сроку.
 *   3. **Грант не подписка.** Ни одной записи в `subscriptions`, ни `charge_id`,
 *      ни автопродления: иначе `subscription_cancel_no_charge_id_24h` начнёт
 *      кричать о том, чего не было.
 *
 * Каждая выдача пишется одной строкой в лог (`grant_issued`): «откуда у
 * человека доступ» должно отвечаться без раскопок в БД.
 */
export interface IssueGrantInput {
  readonly userId: string;
  readonly kind: GrantKind;
  readonly source: GrantSource;
  readonly days?: number | null;
  readonly codeId?: string | null;
  /** Метка кода для лога. Не ПДн: имя партнёра или акции. */
  readonly code?: string | null;
  /**
   * Проверять бюджет. `false` только у отзыва/внутренних продлений: бюджет
   * ограничивает новые обещания, а не снятие уже выданных.
   */
  readonly checkBudget?: boolean;
}

export interface IssuedGrant {
  readonly grant: GrantRow;
  /** `true` — право продлило существующее, а не создало новое. */
  readonly extended: boolean;
  /** `true` — срок ждёт первой карты. */
  readonly pending: boolean;
}

@Injectable()
export class GrantsService {
  constructor(
    @Inject(GrantsRepository) private readonly repo: GrantsRepository,
    @Inject(BonusBudgetService) private readonly budget: BonusBudgetService,
    @Inject(DbService) private readonly db: DbService,
    @Inject(JsonLogger) private readonly logger: JsonLogger,
  ) {}

  /** Есть ли у человека карта: от этого зависит, начнётся ли срок сразу. */
  async hasChart(userId: string): Promise<boolean> {
    const row = await this.db.queryOne<{ one: number }>(
      `SELECT 1 AS one FROM charts WHERE user_id = $1 LIMIT 1`,
      [userId],
    );

    return row !== null;
  }

  async issue(input: IssueGrantInput): Promise<IssuedGrant> {
    if (input.checkBudget !== false) {
      await this.budget.ensureAvailable(`${input.source}:${input.kind}`);
    }

    const kind = input.kind;
    const days = kind === 'all_access' ? (input.days ?? 0) : null;

    if (kind === 'all_access' && (days === null || days <= 0)) {
      // Дни — не украшение: без них нечего продлевать и не из чего посчитать
      // бюджет. Это ошибка вызывающего кода, а не пользователя.
      throw new Error('grant_all_access_requires_days');
    }

    const startNow = await this.hasChart(input.userId);

    const result = await this.db.withTransaction(async (client) => {
      if (kind === 'all_access') {
        const extended = await this.repo.extendAllAccess(client, input.userId, days ?? 0, startNow);

        if (extended !== null) {
          return { grant: extended, extended: true };
        }
      }

      const inserted = await this.repo.insert(client, {
        userId: input.userId,
        kind,
        source: input.source,
        codeId: input.codeId ?? null,
        days,
        startNow,
      });

      return { grant: inserted, extended: false };
    });

    this.logger.info('grant_issued', {
      user: input.userId,
      kind,
      source: input.source,
      days: days ?? 0,
      code: input.code ?? 'none',
      extended: result.extended,
      pending: result.grant.starts_at === null,
    });

    return {
      grant: result.grant,
      extended: result.extended,
      pending: result.grant.starts_at === null,
    };
  }

  /**
   * Запуск ожидающих прав после первой карты.
   *
   * Возвращает число запущенных прав — вызывающему (`ChartsService`) это нужно
   * только для лога; отказ внутри не должен ронять создание карты, поэтому
   * ошибки ловит вызывающий.
   */
  async startPendingFor(userId: string): Promise<number> {
    return this.db.withTransaction(async (client) => {
      const rows = await this.repo.startPending(client, userId);

      for (const row of rows) {
        this.logger.info('grant_started', {
          user: userId,
          kind: row.kind,
          source: row.source,
          days: row.days ?? 0,
          expires_at: row.expires_at?.toISOString() ?? null,
        });
      }

      return rows.length;
    });
  }

  async revoke(userId: string, grantId: string): Promise<GrantRow> {
    const row = await this.repo.revoke(userId, grantId);

    if (row === null) {
      throw notFound(reasonOptions('grant_not_found', 'Такого права нет или оно уже отозвано'));
    }

    this.logger.info('grant_revoked', {
      user: userId,
      grant: grantId,
      kind: row.kind,
      source: row.source,
    });

    return row;
  }

  listForUser(userId: string): Promise<readonly GrantRow[]> {
    return this.repo.listForUser(userId);
  }

  /** Админский список: история выдач, отзывов и расходов. */
  listForAdmin(userId: string): Promise<readonly GrantRow[]> {
    return this.repo.listAllForUser(userId);
  }
}
