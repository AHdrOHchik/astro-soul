import { Inject, Injectable } from '@nestjs/common';
import { randomInt } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { GrantKind } from '@astro-soul/shared';
import { ApiError, conflict, invalidFields, notFound, reasonOptions } from '../../common/api-error';
import { JsonLogger } from '../../common/logger';
import { DbService } from '../../db/db.service';
import { BonusBudgetService } from './bonus-budget.service';
import { GrantsRepository } from './grants.repository';
import { GrantsService } from './grants.service';

/**
 * Коды доступа (итерация 39): партнёрская программа и подарки.
 *
 * Код — право на выдачу, а не право само по себе: активация создаёт строку в
 * `grants` и **не создаёт** подписку. Поэтому здесь нет ни цен, ни планов —
 * только «сколько активаций, на сколько дней и до какого срока».
 *
 * Алфавит кода — `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` (без `0`, `O`, `1`, `I`):
 * код диктуют голосом и перепечатывают руками. Проверка формата стоит до
 * запроса в БД, иначе любой мусор в поле «промокод» занимал бы соединение.
 */

/** Алфавит: 32 знака, ни одного похожего при чтении вслух. */
export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** Длина кода. 8 знаков = 32^8 ≈ 1,1 · 10^12 вариантов. */
export const CODE_LENGTH = 8;

const CODE_PATTERN = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/u;

/** Код, как его ввёл человек: пробелы и дефисы убираем, регистр не важен. */
export function normalizeAccessCode(raw: string): string {
  return raw.replace(/[\s-]+/gu, '').toUpperCase();
}

export function generateAccessCode(): string {
  let code = '';
  for (let index = 0; index < CODE_LENGTH; index += 1) {
    code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  }
  return code;
}

export interface AccessCodeRow {
  readonly id: string;
  readonly code: string;
  readonly kind: GrantKind;
  readonly days: number | null;
  readonly max_activations: number;
  readonly activations: number;
  readonly partner_name: string | null;
  readonly is_active: boolean;
  readonly expires_at: Date | null;
  readonly created_at: Date;
}

export interface CreateCodeInput {
  readonly kind: GrantKind;
  readonly days?: number | null;
  readonly maxActivations: number;
  readonly partnerName?: string | null;
  readonly expiresAt?: Date | null;
  /** Явный код — только для тестов и ручной выдачи «красивого» кода. */
  readonly code?: string | null;
}

/** Что человек получил: нужно и в ответе, и в тексте бота по `pt_<code>`. */
export interface ActivatedCode {
  readonly code: string;
  readonly kind: GrantKind;
  readonly days: number | null;
  /** `true` — срок уже идёт (карта есть), `false` — ждёт первой карты. */
  readonly started: boolean;
  readonly expiresAt: Date | null;
}

@Injectable()
export class AccessCodesService {
  constructor(
    @Inject(DbService) private readonly db: DbService,
    @Inject(GrantsRepository) private readonly grants: GrantsRepository,
    @Inject(GrantsService) private readonly grantService: GrantsService,
    @Inject(BonusBudgetService) private readonly budget: BonusBudgetService,
    @Inject(JsonLogger) private readonly logger: JsonLogger,
  ) {}

  /**
   * `POST /admin/codes`: создаёт код. Код уникален, коллизия — повтор.
   *
   * `client` (итерация 40) — транзакция вызывающего: код и запись в журнале
   * аудита должны коммититься вместе. Повтор после коллизии внутри чужой
   * транзакции делается через `SAVEPOINT`: в PostgreSQL ошибка `23505`
   * переводит транзакцию в состояние «aborted», и без точки сохранения второй
   * `INSERT` был бы невозможен.
   */
  async create(input: CreateCodeInput, options: { readonly client?: PoolClient } = {}): Promise<AccessCodeRow> {
    const kind = input.kind;

    if (kind === 'all_access' && (input.days === undefined || input.days === null || input.days <= 0)) {
      throw invalidFields([{ field: 'days', message: 'Для «всё включено» нужны дни' }]);
    }

    if (input.maxActivations <= 0) {
      throw invalidFields([{ field: 'max_activations', message: 'Хотя бы одна активация' }]);
    }

    const explicit = input.code ?? null;
    if (explicit !== null && !CODE_PATTERN.test(explicit)) {
      throw invalidFields([{ field: 'code', message: 'Код — 8 знаков из разрешённого алфавита' }]);
    }

    // Пять попыток на коллизию: при 32^8 это практически невозможно, но
    // `INSERT` без проверки превратил бы «так вышло» в 500.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const code = explicit ?? generateAccessCode();
      try {
        if (options.client !== undefined) {
          // Точка сохранения на попытку: откат возвращает транзакцию в рабочее
          // состояние, и следующая попытка не падает на «aborted transaction».
          await options.client.query('SAVEPOINT access_code_attempt');
        }

        const row = await this.insertRow(code, kind, input, options.client);

        if (options.client !== undefined) {
          await options.client.query('RELEASE SAVEPOINT access_code_attempt');
        }

        if (row !== null) {
          this.logger.info('access_code_created', {
            code: row.code,
            kind: row.kind,
            days: row.days ?? 0,
            max_activations: row.max_activations,
            partner: row.partner_name ?? 'none',
          });

          return row;
        }
      } catch (error) {
        if (options.client !== undefined) {
          await options.client.query('ROLLBACK TO SAVEPOINT access_code_attempt');
        }

        // 23505 — уникальность `code`. Явно заданный код повторять бессмысленно.
        if ((error as { code?: string }).code !== '23505' || explicit !== null) {
          throw error;
        }
      }
    }

    throw conflict(reasonOptions('code_collision', 'Не удалось создать код, попробуй ещё раз'));
  }

  /** Один `INSERT`: через клиент транзакции или через пул. */
  private async insertRow(
    code: string,
    kind: GrantKind,
    input: CreateCodeInput,
    client: PoolClient | undefined,
  ): Promise<AccessCodeRow | null> {
    const params = [
      code,
      kind,
      kind === 'all_access' ? (input.days ?? null) : null,
      input.maxActivations,
      input.partnerName ?? null,
      input.expiresAt ?? null,
    ];

    const sql = `INSERT INTO access_codes (code, kind, days, max_activations, partner_name, expires_at)
                 VALUES ($1, $2, $3, $4, $5, $6)
                 RETURNING id, code, kind, days, max_activations, activations, partner_name,
                           is_active, expires_at, created_at`;

    if (client !== undefined) {
      const result = await client.query<AccessCodeRow>(sql, params);
      return result.rows[0] ?? null;
    }

    return this.db.queryOne<AccessCodeRow>(sql, params);
  }

  async list(options: { readonly limit?: number } = {}): Promise<readonly AccessCodeRow[]> {
    return this.db.query<AccessCodeRow>(
      `SELECT id, code, kind, days, max_activations, activations, partner_name,
              is_active, expires_at, created_at
         FROM access_codes
        ORDER BY created_at DESC
        LIMIT $1`,
      [options.limit ?? 100],
    );
  }

  async findByCode(rawCode: string): Promise<AccessCodeRow | null> {
    return this.db.queryOne<AccessCodeRow>(
      `SELECT id, code, kind, days, max_activations, activations, partner_name,
              is_active, expires_at, created_at
         FROM access_codes
        WHERE code = $1`,
      [rawCode],
    );
  }

  /**
   * Активация кода человеком (`POST /me/activate-code`) или ботом (`pt_<code>`).
   *
   * Порядок проверок важен и продуман:
   *   1. формат — `422`, до БД: мусор не должен занимать соединение;
   *   2. бюджет — `503`, до счётчика: исчерпанный бюджет не имеет права
   *      «съесть» активацию, которая всё равно не выдаст право;
   *   3. код есть и включён — `404` (`code_not_found`); выключенный код для
   *      клиента неотличим от несуществующего, иначе по ответу видно, какие
   *      коды существуют;
   *   4. срок кода — `410` (`code_expired`): это не «нет кода», а «был и кончился»;
   *   5. уже активирован этим человеком — `409` (`already_activated`);
   *   6. атомарный счётчик — `409` (`code_exhausted`).
   *
   * Счётчик увеличивается **до** выдачи права, но в одной транзакции: если
   * выдача упадёт, `ROLLBACK` вернёт и счётчик, и строку активации.
   */
  async activate(userId: string, rawCode: string): Promise<ActivatedCode> {
    const code = normalizeAccessCode(rawCode);

    if (!CODE_PATTERN.test(code)) {
      throw invalidFields([{ field: 'code', message: 'Код — 8 знаков: буквы и цифры' }]);
    }

    await this.budget.ensureAvailable('code_activation');

    const row = await this.findByCode(code);

    if (row === null || !row.is_active) {
      throw notFound(reasonOptions('code_not_found', 'Такого кода нет. Проверь написание'));
    }

    if (row.expires_at !== null && row.expires_at.getTime() <= Date.now()) {
      throw new ApiError('GONE', 410, {
        ...reasonOptions('code_expired', 'Срок действия кода закончился'),
      });
    }

    const already = await this.db.queryOne<{ one: number }>(
      `SELECT 1 AS one FROM access_code_activations WHERE code_id = $1 AND user_id = $2`,
      [row.id, userId],
    );

    if (already !== null) {
      throw conflict(reasonOptions('already_activated', 'Ты уже активировал этот код'));
    }

    const issued = await this.db.withTransaction(async (client) => {
      const counter = await client.query<{ id: string }>(
        `UPDATE access_codes
            SET activations = activations + 1
          WHERE id = $1 AND activations < max_activations
          RETURNING id`,
        [row.id],
      );

      if (counter.rows[0] === undefined) {
        // Счётчик кончился между чтением и `UPDATE`. Именно поэтому он
        // атомарный: иначе два последних человека получили бы право, которого
        // у кода уже нет.
        throw conflict(reasonOptions('code_exhausted', 'Все активации этого кода уже использованы'));
      }

      // Уникальный первичный ключ `(code_id, user_id)` — вторая защита от
      // повторной активации, на случай двух одновременных нажатий.
      await client.query(
        `INSERT INTO access_code_activations (code_id, user_id) VALUES ($1, $2)`,
        [row.id, userId],
      );

      return this.grantService.issue({
        userId,
        kind: row.kind,
        source: 'partner',
        days: row.days,
        codeId: row.id,
        code: row.code,
        // Бюджет уже проверен выше; вторая проверка внутри транзакции могла бы
        // отказать после увеличения счётчика.
        checkBudget: false,
      });
    });

    this.logger.info('access_code_activated', {
      user: userId,
      code: row.code,
      kind: row.kind,
      days: row.days ?? 0,
      partner: row.partner_name ?? 'none',
    });

    return {
      code: row.code,
      kind: row.kind,
      days: row.days,
      started: issued.grant.starts_at !== null,
      expiresAt: issued.grant.expires_at,
    };
  }

  /**
   * Текст «что ты получил» для бота по ссылке `pt_<code>`.
   *
   * Отдельная функция, а не строка в обработчике: один и тот же текст нужен и
   * при активации, и при повторном переходе по ссылке («код уже активирован»).
   */
  describe(activated: ActivatedCode): string {
    const period =
      activated.kind === 'all_access'
        ? `Доступ «всё включено» на ${String(activated.days ?? 0)} дней.`
        : activated.kind === 'single_report'
          ? 'Один полный разбор — бесплатно.'
          : 'Одна совместимость с партнёром — бесплатно.';

    return activated.started
      ? `${period} Права уже в приложении.`
      : `${period} Права включим, как только построишь карту.`;
  }
}
