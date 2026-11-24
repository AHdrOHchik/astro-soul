import { Inject, Injectable } from '@nestjs/common';
import { DbService } from '../../db/db.service';
import type { ListCursor } from './admin-support.dto';

/**
 * Справочники панели: основатели, партнёры, платежи (контракт 1.6.17).
 *
 * Правила, которые держит этот файл:
 *   • **ни одного идентификатора в агрегатах.** `GET /admin/partners` отдаёт
 *     только суммы и счётчики: ни `telegram_id`, ни `user_id`, ни `code`.
 *     Партнёр — внешняя сторона, и его отчёт не должен превращаться в список
 *     клиентов;
 *   • **ПДн не читаются вовсе.** Ни `profiles`, ни `charts` в запросах нет:
 *     основателям и платежам хватает `users.(telegram_id, created_at)`;
 *   • пагинация — keyset по `(created_at, id)`, а не `OFFSET`: между страницами
 *     появляются новые строки, и `OFFSET` показал бы одну и ту же строку дважды.
 */

export interface FounderRow {
  readonly place: number;
  readonly user_id: string;
  readonly telegram_id: string;
  readonly created_at: Date;
  readonly grant_kind: string | null;
  readonly expires_at: Date | null;
  readonly code_activated: boolean;
}

export interface PartnerRow {
  readonly partner_name: string;
  readonly codes_total: number;
  readonly activations_total: number;
  readonly activated_users: number;
  readonly paid_users: number;
  readonly revenue_stars: string;
  readonly last_activation_at: Date | null;
}

export interface PaymentRow {
  readonly id: string;
  readonly charge_id: string;
  readonly user_id: string | null;
  readonly amount_stars: number;
  readonly currency: string;
  readonly status: string;
  readonly created_at: Date;
  readonly refunded_at: Date | null;
  readonly plan_code: string;
}

@Injectable()
export class AdminDirectoryRepository {
  constructor(@Inject(DbService) private readonly db: DbService) {}

  /**
   * Места «первых 50» по порядку заявки.
   *
   * `code_activated` — «человек пришёл по коду» (`access_code_activations`), а не
   * «у него есть право»: это разные вопросы, и на экране основателей нужен
   * первый. `grant_kind`/`expires_at` — **право основателя** (`source =
   * 'founder'`), а не любое его право: иначе у человека с партнёрским кодом
   * экран показывал бы чужую выдачу.
   */
  async founders(
    cursor: ListCursor | null,
    limit: number,
  ): Promise<{ rows: readonly FounderRow[]; nextCursor: ListCursor | null }> {
    const rows = await this.db.query<FounderRow>(
      `SELECT f.place,
              f.user_id::text AS user_id,
              u.telegram_id::text AS telegram_id,
              f.created_at,
              g.kind AS grant_kind,
              g.expires_at,
              EXISTS (
                SELECT 1 FROM access_code_activations a WHERE a.user_id = f.user_id
              ) AS code_activated
         FROM founders f
         JOIN users u ON u.id = f.user_id
         LEFT JOIN LATERAL (
           SELECT gr.kind, gr.expires_at
             FROM grants gr
            WHERE gr.user_id = f.user_id AND gr.source = 'founder' AND gr.revoked_at IS NULL
            ORDER BY gr.created_at DESC
            LIMIT 1
         ) g ON true
        WHERE ($1::timestamptz IS NULL OR (f.created_at, f.user_id) > ($1, $2::uuid))
        ORDER BY f.created_at, f.user_id
        LIMIT $3`,
      [cursor?.createdAt ?? null, cursor?.id ?? null, limit + 1],
    );

    const page = rows.slice(0, limit);
    const last = page[page.length - 1];

    return {
      rows: page,
      nextCursor:
        rows.length > limit && last !== undefined
          ? { createdAt: last.created_at, id: last.user_id }
          : null,
    };
  }

  /**
   * Агрегат по партнёрам.
   *
   * `paid_users` — сколько активировавших код людей **заплатили хотя бы раз**:
   * единственная цифра, которая говорит, работает ли партнёр (активации сами по
   * себе бесплатны). `revenue_stars` — сумма оплаченных платежей этих людей без
   * вычета возвратов: возвращённый платёж имеет `status = 'refunded'` и в сумму
   * не попадает вовсе, поэтому «вычитать» нечего (см. отчёт итерации 43).
   *
   * Партнёр без активаций остаётся в списке с нулями: «код раздали, никто не
   * пришёл» — это ответ, а не пустая строка.
   */
  async partners(): Promise<readonly PartnerRow[]> {
    return this.db.query<PartnerRow>(
      `WITH codes AS (
         SELECT partner_name,
                count(*)::int AS codes_total
           FROM access_codes
          WHERE partner_name IS NOT NULL
          GROUP BY partner_name
       ),
       activations AS (
         SELECT c.partner_name,
                count(*)::int AS activations_total,
                count(DISTINCT a.user_id)::int AS activated_users,
                max(a.activated_at) AS last_activation_at
           FROM access_code_activations a
           JOIN access_codes c ON c.id = a.code_id
          WHERE c.partner_name IS NOT NULL
          GROUP BY c.partner_name
       ),
       activated_users AS (
         SELECT DISTINCT c.partner_name, a.user_id
           FROM access_code_activations a
           JOIN access_codes c ON c.id = a.code_id
          WHERE c.partner_name IS NOT NULL
       ),
       paid AS (
         SELECT u.partner_name,
                count(DISTINCT u.user_id)::int AS paid_users,
                COALESCE(sum(p.stars), 0)::bigint AS revenue_stars
           FROM activated_users u
           LEFT JOIN (
             SELECT user_id, sum(total_amount)::bigint AS stars
               FROM payments
              WHERE status = 'paid' AND user_id IS NOT NULL
              GROUP BY user_id
           ) p ON p.user_id = u.user_id
          GROUP BY u.partner_name
       )
       SELECT c.partner_name,
              c.codes_total,
              COALESCE(a.activations_total, 0) AS activations_total,
              COALESCE(a.activated_users, 0) AS activated_users,
              COALESCE(p.paid_users, 0) AS paid_users,
              COALESCE(p.revenue_stars, 0)::text AS revenue_stars,
              a.last_activation_at
         FROM codes c
         LEFT JOIN activations a ON a.partner_name = c.partner_name
         LEFT JOIN paid p ON p.partner_name = c.partner_name
        ORDER BY COALESCE(a.activated_users, 0) DESC, c.partner_name`,
    );
  }

  /**
   * Платежи для поддержки: главный сценарий — поиск по `charge_id` из чека.
   *
   * `charge_id` — это `telegram_payment_charge_id` (тот самый, который человек
   * видит в чеке Telegram и который нужен `refundStarPayment`). Поиск точный:
   * `ILIKE` по идентификатору платежа находил бы лишнее и выглядел бы как
   * «нашёл», когда не нашёл.
   */
  async payments(input: {
    readonly chargeId: string | null;
    readonly userId: string | null;
    readonly status: string | null;
    readonly cursor: ListCursor | null;
    readonly limit: number;
  }): Promise<{ rows: readonly PaymentRow[]; nextCursor: ListCursor | null }> {
    const rows = await this.db.query<PaymentRow>(
      `SELECT id::text AS id,
              telegram_payment_charge_id AS charge_id,
              user_id::text AS user_id,
              total_amount AS amount_stars,
              currency,
              status::text AS status,
              created_at,
              refunded_at,
              plan_code
         FROM payments
        WHERE ($1::text IS NULL OR telegram_payment_charge_id = $1)
          AND ($2::uuid IS NULL OR user_id = $2::uuid)
          AND ($3::text IS NULL OR status = $3::payment_status)
          AND ($4::timestamptz IS NULL OR (created_at, id) < ($4, $5::uuid))
        ORDER BY created_at DESC, id DESC
        LIMIT $6`,
      [
        input.chargeId,
        input.userId,
        input.status,
        input.cursor?.createdAt ?? null,
        input.cursor?.id ?? null,
        input.limit + 1,
      ],
    );

    const page = rows.slice(0, input.limit);
    const last = page[page.length - 1];

    return {
      rows: page,
      nextCursor:
        rows.length > input.limit && last !== undefined
          ? { createdAt: last.created_at, id: last.id }
          : null,
    };
  }
}
