import { Inject, Injectable } from '@nestjs/common';
import { validationFailed } from '../../common/api-error';
import { APP_ENV } from '../../config/env.module';
import type { AppEnv } from '../../config/env';
import { assertAdmin, type AdminActor } from '../admin-auth/admin-actor';
import {
  AdminDirectoryRepository,
  type FounderRow,
  type PartnerRow,
  type PaymentRow,
} from './admin-directory.repository';
import { encodeCursor, isUuid, parseCursor, parseListLimit } from './admin-support.dto';

/** Основатель в панели: место, кто и что выдано. ПДн нет — только `telegram_id`. */
export interface AdminFounder {
  readonly place: number;
  readonly user_id: string;
  readonly telegram_id: string;
  /**
   * Имя в Telegram. **Всегда `null`**: имена не хранятся вовсе (в базе нет
   * колонки `username`). Поле оставлено в контракте, чтобы панель не
   * переделывала колонку, когда/если владелец решит его хранить.
   */
  readonly username: string | null;
  readonly created_at: string;
  readonly grant_kind: string | null;
  readonly expires_at: string | null;
  readonly code_activated: boolean;
}

export interface AdminFoundersPage {
  readonly items: readonly AdminFounder[];
  readonly next_cursor: string | null;
}

export interface AdminPartner {
  readonly partner_name: string;
  readonly codes_total: number;
  readonly activations_total: number;
  readonly activated_users: number;
  readonly paid_users: number;
  readonly revenue_stars: number;
  readonly last_activation_at: string | null;
}

export interface AdminPartnersPage {
  readonly items: readonly AdminPartner[];
}

export interface AdminPayment {
  readonly charge_id: string;
  readonly user_id: string | null;
  readonly amount_stars: number;
  readonly currency: string;
  readonly status: string;
  readonly created_at: string;
  readonly refunded_at: string | null;
  readonly plan_code: string;
}

export interface AdminPaymentsPage {
  readonly items: readonly AdminPayment[];
  readonly next_cursor: string | null;
}

export interface AdminPaymentQuery {
  readonly charge_id?: unknown;
  readonly user_id?: unknown;
  readonly status?: unknown;
  readonly limit?: unknown;
  readonly cursor?: unknown;
}

export interface AdminPageQuery {
  readonly limit?: unknown;
  readonly cursor?: unknown;
}

const FOUNDERS_LIMITS = { defaultLimit: 50, maxLimit: 50 } as const;
const PAYMENTS_LIMITS = { defaultLimit: 20, maxLimit: 100 } as const;
const PAYMENT_STATUSES = ['paid', 'processed', 'refunded', 'failed'] as const;

/**
 * Справочники панели (контракт 1.6.17): основатели, партнёры, платежи.
 *
 * Три маршрута, которые закрывают экраны «Основатели», «Партнёры» и «Платежи»,
 * и все три — только чтение: ни одна ручка здесь ничего не меняет, поэтому и
 * аудита в них нет (аудит есть у действий — возврата, бана, бэкапа, вебхука).
 *
 * ПДн нет ни в одном ответе: у основателей — место, `telegram_id` и выдача, у
 * партнёров — только суммы, у платежей — `charge_id` и `user_id` (без него
 * поддержка не свяжет платёж с человеком, а сам по себе это псевдоним).
 */
@Injectable()
export class AdminDirectoryService {
  constructor(
    @Inject(AdminDirectoryRepository) private readonly repo: AdminDirectoryRepository,
    @Inject(APP_ENV) private readonly env: AppEnv,
  ) {}

  /**
   * `GET /admin/founders` — места 1…50 по дате заявки, `limit` до 50.
   *
   * Верхняя граница — 50: мест всего 50, и «покажи 500» бессмысленно. Ответ
   * всё равно с `next_cursor` (при `limit = 50` он `null`): панель написана под
   * курсор, и второй формы ответа быть не должно.
   */
  async founders(actor: AdminActor, query: AdminPageQuery): Promise<AdminFoundersPage> {
    this.ensureAdmin(actor, 'founders.list');

    const limit = parseListLimit(query.limit, FOUNDERS_LIMITS);
    const cursor = parseCursor(query.cursor);
    const { rows, nextCursor } = await this.repo.founders(cursor, limit);

    return {
      items: rows.map((row) => this.toFounder(row)),
      next_cursor: nextCursor === null ? null : encodeCursor(nextCursor.createdAt, nextCursor.id),
    };
  }

  /** `GET /admin/partners` — агрегаты по партнёрам; без `limit` (их единицы). */
  async partners(actor: AdminActor): Promise<AdminPartnersPage> {
    this.ensureAdmin(actor, 'partners.list');

    const rows = await this.repo.partners();

    return { items: rows.map((row) => this.toPartner(row)) };
  }

  /**
   * `GET /admin/payments` — поиск платежа.
   *
   * Фильтры необязательны все: без них это «последние платежи», и это осознанно
   * — в отличие от списка людей (где «покажи всех» запрещён), платежи не
   * содержат ПДн, а поддержке нужен именно последний поток.
   */
  async payments(actor: AdminActor, query: AdminPaymentQuery): Promise<AdminPaymentsPage> {
    this.ensureAdmin(actor, 'payments.list');

    const limit = parseListLimit(query.limit, PAYMENTS_LIMITS);
    const cursor = parseCursor(query.cursor);
    const chargeId = this.readTrimmed(query.charge_id, 'charge_id');
    const userId = this.readUuid(query.user_id);
    const status = this.readStatus(query.status);

    const { rows, nextCursor } = await this.repo.payments({
      chargeId,
      userId,
      status,
      cursor,
      limit,
    });

    return {
      items: rows.map((row) => this.toPayment(row)),
      next_cursor: nextCursor === null ? null : encodeCursor(nextCursor.createdAt, nextCursor.id),
    };
  }

  private ensureAdmin(actor: AdminActor, action: string): void {
    assertAdmin(actor, this.env.ADMIN_TG_ID);
    void action;
  }

  private toFounder(row: FounderRow): AdminFounder {
    return {
      place: row.place,
      user_id: row.user_id,
      telegram_id: row.telegram_id,
      username: null,
      created_at: row.created_at.toISOString(),
      grant_kind: row.grant_kind,
      expires_at: row.expires_at?.toISOString() ?? null,
      code_activated: row.code_activated,
    };
  }

  private toPartner(row: PartnerRow): AdminPartner {
    return {
      partner_name: row.partner_name,
      codes_total: row.codes_total,
      activations_total: row.activations_total,
      activated_users: row.activated_users,
      paid_users: row.paid_users,
      revenue_stars: Number(row.revenue_stars),
      last_activation_at: row.last_activation_at?.toISOString() ?? null,
    };
  }

  private toPayment(row: PaymentRow): AdminPayment {
    return {
      charge_id: row.charge_id,
      user_id: row.user_id,
      amount_stars: row.amount_stars,
      currency: row.currency,
      status: row.status,
      created_at: row.created_at.toISOString(),
      refunded_at: row.refunded_at?.toISOString() ?? null,
      plan_code: row.plan_code,
    };
  }

  private readTrimmed(value: unknown, field: string): string | null {
    if (value === undefined || value === '') {
      return null;
    }

    if (typeof value !== 'string' || value.trim().length < 3) {
      throw validationFailed({
        message: `${field}: минимум 3 символа`,
        details: {
          reason: 'invalid_filter',
          field_errors: [{ field, message: 'Минимум 3 символа' }],
        },
      });
    }

    return value.trim();
  }

  private readUuid(value: unknown): string | null {
    if (value === undefined || value === '') {
      return null;
    }

    if (typeof value !== 'string' || !isUuid(value)) {
      throw validationFailed({
        message: 'user_id — UUID',
        details: {
          reason: 'invalid_filter',
          field_errors: [{ field: 'user_id', message: 'UUID' }],
        },
      });
    }

    return value;
  }

  private readStatus(value: unknown): string | null {
    if (value === undefined || value === '') {
      return null;
    }

    if (
      typeof value !== 'string' ||
      !PAYMENT_STATUSES.includes(value as (typeof PAYMENT_STATUSES)[number])
    ) {
      throw validationFailed({
        message: `Одно из: ${PAYMENT_STATUSES.join(', ')}`,
        details: {
          reason: 'invalid_filter',
          field_errors: [{ field: 'status', message: 'Недопустимое значение' }],
        },
      });
    }

    return value;
  }
}
