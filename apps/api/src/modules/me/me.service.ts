import { Inject, Injectable } from '@nestjs/common';
import type { Entitlements, Me, OnboardingStep } from '@astro-soul/shared';
import { DbService } from '../../db/db.service';
import { conflict } from '../../common/api-error';
import { displayNameOf, type VerifiedInitData } from '../auth/init-data';
import { UsersRepository } from '../users/users.repository';
import { EntitlementsService } from '../entitlements/entitlements.service';
import { QuotasService } from '../quotas/quotas.service';
import { EventsRepository } from '../events/events.repository';
import { FileStorageService } from '../files/file-storage.service';
import { PdfRepository } from '../pdf/pdf.repository';
import { PaymentsService } from '../billing/payments.service';
import { SubscriptionCancelService } from '../billing/subscription-cancel.service';
import { TelegramInlineService } from '../telegram/telegram-inline.service';
import { APP_ENV } from '../../config/env.module';
import type { AppEnv } from '../../config/env';
import { JsonLogger } from '../../common/logger';

/**
 * `Entitlements` (packages/shared, camelCase) → контракт (`Me.entitlements`,
 * snake_case, как и остальные поля ответа).
 */
export function toEntitlementsDto(entitlements: Entitlements): NonNullable<Me['entitlements']> {
  return {
    is_active: entitlements.isActive,
    plan: entitlements.plan,
    full_forecast: entitlements.fullForecast,
    ask_per_day: entitlements.askPerDay as 0 | 1 | 5 | -1,
    full_report: entitlements.fullReport,
    full_report_chart_id: entitlements.fullReportChartId,
    compat_per_month: entitlements.compatPerMonth,
    solar_included: entitlements.solarIncluded,
  };
}

@Injectable()
export class MeService {
  constructor(
    @Inject(UsersRepository) private readonly users: UsersRepository,
    @Inject(EntitlementsService) private readonly entitlements: EntitlementsService,
    @Inject(QuotasService) private readonly quotas: QuotasService,
    @Inject(DbService) private readonly db: DbService,
    @Inject(EventsRepository) private readonly events: EventsRepository,
    @Inject(PdfRepository) private readonly pdfs: PdfRepository,
    @Inject(FileStorageService) private readonly storage: FileStorageService,
    @Inject(PaymentsService) private readonly payments: PaymentsService,
    @Inject(SubscriptionCancelService) private readonly subscriptionCancel: SubscriptionCancelService,
    @Inject(TelegramInlineService) private readonly inline: TelegramInlineService,
    @Inject(APP_ENV) private readonly env: AppEnv,
    @Inject(JsonLogger) private readonly logger: JsonLogger,
  ) {}

  /** Пояс места рождения последней карты — для ключей дневных квот. */
  private async latestChartTimeZone(userId: string): Promise<string> {
    const row = await this.db.queryOne<{ tz: string | null }>(
      `SELECT data -> 'chart' -> 'birth' -> 'place' ->> 'tz' AS tz
         FROM charts
        WHERE user_id = $1
        ORDER BY created_at DESC
        LIMIT 1`,
      [userId],
    );
    return row?.tz ?? 'UTC';
  }

  /** Последний разбор пользователя любого незавершённого/готового статуса. */
  private async latestReportId(userId: string): Promise<string | null> {
    const row = await this.db.queryOne<{ id: string }>(
      `SELECT id FROM reports
        WHERE user_id = $1 AND kind = 'report'
        ORDER BY created_at DESC
        LIMIT 1`,
      [userId],
    );
    return row?.id ?? null;
  }

  async getMe(auth: VerifiedInitData): Promise<Me> {
    const { userId, isNew } = await this.users.ensureUser({
      telegramUserId: auth.telegramUserId,
      languageCode: auth.user.language_code,
    });

    const [profileState, entitlements, subscription, latestReportId] = await Promise.all([
      this.users.getProfileState(userId),
      this.entitlements.getEntitlements(userId),
      this.entitlements.getSubscriptionState(userId),
      // QA-18: без этого поля заказ «теряется» после закрытия мини-аппа,
      // и человек платит второй раз. Всегда есть в ответе, `null` — нет разборов.
      this.latestReportId(userId),
    ]);

    // Местные сутки карты — та же шкала, что у квоты «спроси карту»
    // (`/engagement/ask`). Иначе `/me` и отказ по квоте расходятся на сутки
    // у людей в поясах, где «сегодня» уже другое.
    const timeZone = await this.latestChartTimeZone(userId);
    const quotas = await this.quotas.listQuotas(userId, entitlements, new Date(), timeZone);

    const onboardingStep: OnboardingStep =
      profileState.onboardingStep ?? (profileState.hasProfile ? 'done' : 'birth_date');

    return {
      user_id: userId,
      // Имя берём из проверенного initData и не сохраняем: это ПДн.
      display_name: displayNameOf(auth.user),
      is_new: isNew,
      has_profile: profileState.hasProfile,
      has_chart: profileState.hasChart,
      // Карта, к которой ведёт кнопка «моя карта» и `GET /charts/current`.
      chart_id: profileState.chartId,
      latest_report_id: latestReportId,
      subscription,
      // Реальные права из getEntitlements(userId): фронт рисует по ним
      // пейволл, но доступ всё равно решается на сервере (payments.md §4).
      entitlements: toEntitlementsDto(entitlements),
      quotas,
      onboarding_step: onboardingStep,
      // Границы предпроверки ввода для поиска города. Только два числа:
      // `default/max limit` клиенту не нужны — `limit` он не передаёт, а
      // потолок решает сервер. Клиент без этого поля (старый сервер) просто
      // не блокирует ввод и полагается на `422` с `field_errors[0].field = query`.
      limits: {
        geo_min_query_length: this.env.GEO_MIN_QUERY_LENGTH,
        geo_max_query_length: this.env.GEO_MAX_QUERY_LENGTH,
      },
      // Что клиент может сделать с шарингом — до создания карточки
      // (контракт 1.6.10). Без этого поля кнопка «Поделиться» выглядела бы
      // рабочей, а первый тап не открывал ничего: `share_url` приходит только
      // в ответе `POST /share/card`, и только там клиент узнавал, что ссылки
      // нет вовсе.
      share: {
        // Тот же признак, что делает `ShareCard.share_url` не-`null`.
        link: this.env.BOT_USERNAME !== undefined,
        // Последнее известное `getMe().supports_inline_queries`; `unknown` —
        // проверки не было. Не «выключено»: `/setinline` мог включить режим
        // уже после старта API.
        inline: this.inline.mode(),
      },
    };
  }

  /**
   * `DELETE /me` (SPEC «Сценарий 6», ПДн).
   *
   * Удаляем ПДн (`users` и каскадом `profiles`, `charts`, `reports`,
   * `forecasts`, `asks`, плюс квоты) и **разрываем связь с деньгами**:
   * `user_id` обнуляется в `payments`, `subscriptions`, `entitlements` и
   * `events`, права отзываются, подписка отменяется.
   *
   * Почему мало `telegram_id = NULL` (блокер A): `user_id` — не случайный
   * uuid, а `HMAC(PSEUDONYM_PEPPER, "telegram:<id>")`. Тот же человек при
   * первом входе получает **тот же** `user_id`, и старая подписка с правами
   * снова указывает на живую строку `users`. Поэтому обнуляем сам ключ, а не
   * только telegram_id: возвращение начинается с чистого листа.
   *
   * Что остаётся: `payments` как бухгалтерия (`plan_code`, `total_amount`,
   * `paid_at`, `telegram_payment_charge_id`) — по charge_id работает
   * `refundStarPayment`. `payments.telegram_id` живёт ещё
   * `PAYMENT_REFUND_WINDOW_DAYS` дней: Bot API возвращает звёзды только по
   * паре (user_id, charge_id), и без него возврат после удаления был бы
   * невозможен. Дальше его снимает `pdn_retention_cleanup`.
   *
   * **Автопродление в Telegram.** Локальная `cancelled` не отменяет подписку в
   * Telegram: звёзды продолжают списываться за следующий период, и человек,
   * удаливший данные, видит новое списание. Поэтому до транзакции вызывается
   * `editUserStarSubscription(is_canceled: true)` (задача A). Порядок
   * обязателен: пару (telegram_id, charge_id) читаем, пока `user_id` ещё есть.
   * Ошибка Telegram удаление не блокирует — результат пишется в
   * `subscriptions.telegram_cancel_state`, неуспех повторяет ночной джоб.
   *
   * QA-14: зависший платёж больше не тупик. Сначала его разрешает тот же код,
   * что и вебхук (`pending_payments_resolve`): доставит доступ или пометит
   * отказом. Если он всё ещё висит — звёзды возвращаются сразу, и только
   * неудачный возврат даёт 409 `refund_failed` с контактом поддержки: молча
   * отдать деньги и удалить аккаунт нельзя.
   */
  async deleteMe(auth: VerifiedInitData): Promise<void> {
    const userId = this.users.userIdFor(auth.telegramUserId);

    // Ключи файлов читаются **до** транзакции: `report_pdfs` уйдёт каскадом
    // вместе с пользователем, и после коммита узнать имена файлов будет негде.
    // PDF разбора — это текст разбора целиком, то есть самые персональные
    // данные из всего, что мы храним: файл обязан исчезнуть вместе со строкой.
    const pdfKeys = await this.pdfs.keysForUser(userId);

    await this.resolvePendingPayments(userId);
    await this.refundStillPendingPayments(userId);

    // 1. Telegram — до транзакции: пара (telegram_id, charge_id) ещё доступна.
    //    Метод не бросает; даже если бросит, удаление всё равно пойдёт: право
    //    человека на удаление первично (152-ФЗ), а не доступность Bot API.
    let cancel: Awaited<ReturnType<SubscriptionCancelService['cancelForUser']>>;
    try {
      cancel = await this.subscriptionCancel.cancelForUser(userId);
    } catch (error) {
      this.logger.warn('telegram_cancel_state', {
        state: 'failed',
        code: 'telegram_error',
        error: error instanceof Error ? error.name : 'unknown',
      });
      cancel = { state: 'failed', attempted: true, code: 'telegram_error' };
    }

    // 2. Локальное удаление — независимо от результата выше.
    await this.db.withTransaction(async (client) => {
      // Порядок: сначала снимаем права и отменяем подписку, потом рвём связь с
      // платежами и событиями, и только затем удаляем пользователя. Всё это
      // одна транзакция, поэтому окна «права уже не те, а user_id ещё тот» нет.
      //
      // `cancelled`, а не `expired`: `expired` — «срок вышел сам», тут — воля
      // пользователя. Метрика `subscription_expired` на удаление не пишется.
      // Состояние отмены автопродления пишется той же строкой: результат
      // вызова Telegram и локальная отмена — одно событие, а не два.
      //
      // Если подписки не было (`attempted = false`), колонки не трогаем: у
      // строки, отменённой раньше, может стоять `failed` — её ещё ждёт повтор
      // из ночного джоба, и затирать это состояние нельзя.
      await client.query(
        `UPDATE subscriptions
            SET status = 'cancelled', user_id = NULL, anonymized_at = now(),
                telegram_cancel_state = CASE
                  WHEN $2::boolean THEN $3::telegram_cancel_state
                  ELSE telegram_cancel_state
                END,
                telegram_cancel_attempts = telegram_cancel_attempts + CASE WHEN $2::boolean THEN 1 ELSE 0 END,
                telegram_cancel_last_at = CASE WHEN $2::boolean THEN now() ELSE telegram_cancel_last_at END
          WHERE user_id = $1`,
        [userId, cancel.attempted, cancel.state],
      );

      // Права отзываются: `revoked` — «снято волей пользователя», а не
      // `refunded` («звёзды вернули»). `chart_id` обнуляем явно: карта уйдёт
      // каскадом, но ссылка не должна пережить владельца ни на миг.
      await client.query(
        `UPDATE entitlements
            SET status = 'revoked', user_id = NULL, chart_id = NULL,
                partner_chart_id = NULL, anonymized_at = now()
          WHERE user_id = $1`,
        [userId],
      );

      // Платежи переживают удаление как бухгалтерия: charge_id нужен для
      // возвратов. `user_id` и `invoice_payload` (в нём лежит `u=<user_id>`)
      // обнуляем. `telegram_id` остаётся до конца окна возврата — без него
      // Bot API не вернёт звёзды.
      await client.query(
        `UPDATE payments
            SET user_id = NULL, invoice_payload = NULL, anonymized_at = now()
          WHERE user_id = $1 AND anonymized_at IS NULL`,
        [userId],
      );

      // События: ПДн в них нет, но `user_id` детерминирован — по нему видно,
      // что этот человек платил. Отвязываем и их.
      await client.query(
        `UPDATE events SET user_id = NULL, anonymized_at = now() WHERE user_id = $1`,
        [userId],
      );

      // QA-15: порядок важен. Сначала разрешили/вернули зависшие платежи (выше),
      // потом аннулируем живые инвойсы, и только затем удаляем пользователя:
      // иначе останется окно, где пользователя уже нет, а инвойс ещё оплатим.
      const invalidated = await this.payments.invalidateInvoices(client, userId);

      await client.query(`DELETE FROM quotas WHERE user_id = $1`, [userId]);

      // Совместимость (итерация 23): данные партнёра — ПДн третьего лица,
      // которое согласия не давало. Они удаляются здесь же, в этой
      // транзакции, а не «каскадом когда-нибудь»: `compat_partners` висит на
      // `users` каскадом, но проверять удаление ПДн по намерению схемы, а не
      // по запросу, — это как раз тот случай, когда «каскад был» узнают из
      // инцидента. Заказы удаляются первыми: `reports.compat_partner_id`
      // стоит `ON DELETE SET NULL`, и молча осиротевший разбор остался бы
      // в базе без пары, за которую заплатили.
      const compatRows = await client.query(
        `DELETE FROM reports WHERE user_id = $1 AND kind = 'compat'`,
        [userId],
      );
      const partnerRows = await client.query(
        `DELETE FROM compat_partners WHERE user_id = $1`,
        [userId],
      );

      await client.query(`DELETE FROM users WHERE id = $1`, [userId]);

      this.logger.info('account_deleted', {
        invoices_invalidated: invalidated,
        telegram_cancel_state: cancel.state,
        compatibilities_deleted: compatRows.rowCount ?? 0,
        compat_partners_deleted: partnerRows.rowCount ?? 0,
        pdf_keys_deleted: pdfKeys.length,
      });
    });

    // 3. Файлы на диске — после коммита, но в том же обработчике.
    //
    // Почему после, а не внутри: удаление файла нельзя откатить транзакцией,
    // поэтому «сначала БД, потом диск» — единственный порядок, при котором
    // сбой диска оставляет недостижимый мусор, а не живую ссылку на удалённые
    // данные. Ошибка удаления не роняет `DELETE /me`: право на удаление
    // первично, а факт пишется в лог и в метрику.
    const removedFiles = await this.storage.removeMany(pdfKeys);
    this.logger.info('account_files_deleted', {
      pdf_files: pdfKeys.length,
      pdf_files_removed: removedFiles,
    });

    await this.events.log({ name: 'account_deleted' });
  }

  /** Разрешить зависшие платежи тем же путём, что и вебхук. */
  private async resolvePendingPayments(userId: string): Promise<void> {
    for (const chargeId of await this.payments.unprocessedChargesOf(userId)) {
      try {
        await this.payments.resolvePending(chargeId);
      } catch {
        // Не вышло доставить — ниже попробуем вернуть звёзды.
      }
    }
  }

  /**
   * После разрешения: если платёж всё ещё `paid`/`unprocessed`, возвращаем звёзды.
   * Не удалось — 409 с `details.reason = "refund_failed"` и контактом поддержки.
   */
  private async refundStillPendingPayments(userId: string): Promise<void> {
    const charges = await this.payments.unprocessedChargesOf(userId);

    if (charges.length === 0) {
      return;
    }

    const failed: string[] = [];
    for (const chargeId of charges) {
      const refunded = await this.payments.refund(chargeId, 'delete_with_pending');
      if (!refunded) {
        failed.push(chargeId);
      }
    }

    if (failed.length > 0) {
      const contact = this.env.SUPPORT_CONTACT;
      throw conflict({
        reason: 'refund_failed',
        details: { reason: 'refund_failed' },
        message:
          contact === undefined
            ? 'Не получилось вернуть звёзды за незавершённую оплату. Напиши в поддержку — вернём вручную.'
            : `Не получилось вернуть звёзды за незавершённую оплату. Напиши в поддержку ${contact} — вернём вручную.`,
      });
    }
  }
}
