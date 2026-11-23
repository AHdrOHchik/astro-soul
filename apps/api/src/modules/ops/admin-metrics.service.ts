import { Inject, Injectable } from '@nestjs/common';
import { DbService } from '../../db/db.service';
import { APP_ENV } from '../../config/env.module';
import type { AppEnv } from '../../config/env';
import { breakerState, validationStreak, type ReportHistoryRow } from '../reports/breaker';
import { TelegramWebhookService } from '../telegram/telegram-webhook.service';
import { EngagementRepository } from '../engagement/engagement.repository';
import { BonusBudgetService } from '../grants/bonus-budget.service';

/**
 * Метрики продукта (`GET /admin/metrics`, контракт 1.4.0).
 *
 * Принципы:
 *   • только агрегаты, ни одного ПДн и ни одного telegram_id;
 *   • воронка и счётчики событий считаются по `events.occurred_at` —
 *     клиентскому времени, — потому что батч может прийти с задержкой до
 *     суток, и без этого вчерашние шаги попадали бы в сегодняшний день.
 *     У серверных событий (платежи) клиентского времени нет, для них берём
 *     `created_at`: `COALESCE(occurred_at, created_at)`.
 */
export interface ProductMetrics {
  readonly mau: number;
  readonly paying: number;
  readonly conversion_to_paid: number;
  readonly churn_30d: number;
  readonly stars_received_30d: number;
  /** Стоимость LLM в рублях за 30 дней — по `reports.llm_cost_rub`. */
  readonly llm_cost_rub_30d: number;
  readonly reports_failed_30d: number;
  /**
   * Circuit breaker разборов (итерация 17): сколько провалов валидации подряд
   * и закрыт ли приём новых разборов. Без этого массовый провал был виден
   * только как «failed» в логах — и молча жёг бюджет.
   */
  readonly reports_validation_streak: number;
  readonly reports_breaker_open: boolean;
  /** Когда истекла последняя серия (`null` — провалов не было). */
  readonly reports_breaker_last_failed_at: string | null;
  /** QA-11: платежи, по которым доступ не выдан. */
  readonly payments_rejected_30d: number;
  readonly amount_mismatch_30d: number;
  readonly refunded_30d: number;
  readonly pending_payments_now: number;
  /**
   * Здоровье оплаты **за 24 часа** (итерация 25).
   *
   * 30-дневные цифры не отвечают на вопрос «оплата сломалась сейчас или
   * всегда так работала»: один отказ в сутки и тридцать отказов за месяц
   * выглядят одинаково. Пара `pre_checkout_total_24h` / `_rejected_24h`
   * разделяет «Telegram не доставляет запросы» (`total = 0`, а `payments`
   * при этом пусто) и «доставляет, но мы отказываем» (`rejected` растёт):
   * в первом случае чинят вебхук, во втором — данные счёта.
   *
   * `successful_payment_total_24h` — сколько платежей дошло (любой статус:
   * `paid`, `rejected`, `refunded` — это всё факты списания звёзд).
   * `payment_failed_24h` — из них те, по которым доступ **не** выдан.
   * Расхождение `successful_payment_total_24h > payment_failed_24h` —
   * норма, обратное (много отказов) — повод читать `reject_reason`.
   */
  readonly pre_checkout_total_24h: number;
  readonly pre_checkout_rejected_24h: number;
  readonly pre_checkout_timeout_24h: number;
  readonly successful_payment_total_24h: number;
  readonly payment_failed_24h: number;
  /** Задача A: сколько отмен автопродления в Telegram не прошло за 30 дней. */
  readonly subscription_cancel_failed_30d: number;
  /**
   * Сколько подписок всё ещё ждут повтора отмены в Telegram.
   *
   * Считается по `telegram_cancel_state = 'failed'` без оглядки на статус: с
   * итерации 29 отменённая подписка остаётся `active` (доступ живёт до конца
   * периода), и такая строка тоже ждёт повтора.
   */
  readonly subscriptions_cancelled_pending_telegram: number;
  /**
   * Отмены автопродления за сутки (итерация 29): сколько прошло и сколько нет.
   *
   * Источник — события `subscription_cancelled` /
   * `subscription_cancel_failed`, потому что оба пути (`DELETE /me` и
   * `POST /subscription/cancel`) пишут одну и ту же пару событий. Считать по
   * `subscriptions.cancelled_at` нельзя: там только успехи, а провалы — это
   * строки, которые ещё ждут повтора.
   */
  readonly subscription_cancel_total_24h: number;
  readonly subscription_cancel_failed_24h: number;
  /**
   * Из провалов за сутки — те, где нет `charge_id`.
   *
   * Это не отказ Telegram, а наша дырка: платёж прошёл, а идентификатор
   * платежа мы не сохранили. Отдельная цифра нужна, чтобы такой случай искали
   * в данных, а не в доступности Bot API.
   */
  readonly subscription_cancel_no_charge_id_24h: number;
  /** Сколько действующих подписок уже не продлятся (`auto_renew = false`). */
  readonly subscriptions_auto_renew_off: number;
  /**
   * Платежи по тестовому тарифу (`test_1`) за 30 дней — отдельная цифра, а не
   * часть выручки: владелец должен видеть свою тестовую звезду, чтобы не
   * забыть выключить `PAYMENTS_TEST_PLANS`.
   */
  readonly test_payments_30d: number;
  /**
   * Включены ли тестовые тарифы **сейчас** (`PAYMENTS_TEST_PLANS=1`).
   *
   * `test_payments_30d` отвечает на вопрос «были ли тестовые платежи», а этот
   * флаг — «продаётся ли сейчас за 1 ⭐». На проде `true` значит забытый флаг:
   * витрина отдаёт тарифы за звезду любой минуты, пока его не снимут.
   */
  readonly test_plans_active: boolean;
  /**
   * Доставка `pre_checkout_query` — по последней проверке вебхука
   * (итерация 26).
   *
   * Раньше единственным следом «вебхук не зарегистрирован» были нули в
   * `pre_checkout_total_24h`, то есть вопрос «а вебхук-то на месте?» требовал
   * ssh. Здесь ответ читается прямо: `false` — адрес не подтверждён, оплата
   * в Telegram не пройдёт; `checked_at` показывает, насколько ответ свежий.
   * Не из БД: это состояние процесса, поэтому меняется в ту же секунду.
   */
  readonly telegram_webhook_ok: boolean;
  readonly telegram_webhook_checked_at: string | null;
  readonly events_30d: Readonly<Record<string, number>>;
  readonly funnel_30d: Readonly<Record<string, number>>;
  /**
   * Совместимость (итерация 23). Отдельные цифры, а не «reports + compat»:
   * у продукта свой брейкер, свой потолок стоимости и своя квота, и общий
   * счётчик скрыл бы, что продаётся, а что нет.
   */
  readonly compat_ready_30d: number;
  readonly compat_failed_30d: number;
  /** Сколько совместимостей можно выдать прямо сейчас (кредиты + окна подписок). */
  readonly compat_credits_left: number;
  readonly compat_validation_streak: number;
  readonly compat_breaker_open: boolean;
  /**
   * Сколько разделов совместимости за сутки пришлось обрезать и сколько
   * всё-таки выбросили (итерация 27).
   *
   * Обрезка — штатная починка формы: если её число растёт, промпт просит
   * «700–900 знаков», а модель пишет вдвое больше, и это видно по цифре, а не
   * по жалобе владельца. Выбросы обязаны быть близки к нулю: раздел теряется
   * только на пустом или неразобранном ответе, не на длине.
   */
  readonly compat_sections_trimmed_24h: number;
  readonly compat_sections_dropped_24h: number;
  /**
   * Прогноз дня и «спроси карту» за 24 часа (итерация 30).
   *
   * Почему окно сутки, а не 30 дней: и прогноз, и вопрос — ежедневные действия.
   * Тридцатидневная сумма по ним ничего не говорит о том, что происходит
   * сегодня, а именно это решает, чинить ли сейчас.
   *
   * Источники разные и это осознанно:
   *   • `forecast_ready` / `forecast_failed` / `forecast_facts_only` /
   *     `forecast_cache_hits` — события, потому что у бесплатного экрана и
   *     кэш-попадания нет строки в БД (ничего не создаётся, ничего не меняется);
   *   • `forecast_cost_rub` и все `questions_*` — по таблицам: там есть
   *     статус, стоимость и длительность, и агрегировать их из событий значило
   *     бы держать две копии одного факта.
   */
  readonly forecast_ready_24h: number;
  readonly forecast_failed_24h: number;
  readonly forecast_facts_only_24h: number;
  readonly forecast_cache_hits_24h: number;
  readonly forecast_cost_rub_24h: number;
  readonly questions_ready_24h: number;
  readonly questions_failed_24h: number;
  readonly questions_refused_24h: number;
  /**
   * Отказы за сутки по причинам — закрытый список `RefusalReason`.
   *
   * Разбивка нужна продукту: «пять отказов» и «пять отказов про здоровье» —
   * разные решения (второе — быть может, стоит честно сказать в интерфейсе,
   * о чём карта не отвечает).
   */
  readonly questions_refused_by_reason: Readonly<Record<string, number>>;
  /**
   * Провалы совместимости за 24 часа (1.6.7).
   *
   * С 1.6.7 неудачный заказ не виден человеку в `GET /compatibility` — и
   * именно поэтому цифра нужна здесь: без неё провал не был бы виден нигде,
   * кроме лога. Считается по `reports.updated_at`, как и `compat_failed_30d`:
   * провал фиксируется обновлением строки.
   */
  readonly compat_failed_24h: number;
  /**
   * Стоимость совместимостей за сутки (1.6.11, итерация 36).
   *
   * Отдельная цифра, потому что она нужна алерту «расход LLM»: без неё сумма
   * `forecast + questions` не видит третий источник трат, и предупреждение о
   * бюджете молчало бы ровно тогда, когда совместимости пишутся пачками.
   * Считается по `reports.llm_cost_rub` (`kind = 'compat'`): там уже лежит
   * стоимость каждого заказа.
   */
  readonly compat_cost_rub_24h: number;
  readonly questions_cost_rub_24h: number;
  /**
   * p95 времени ответа на вопрос, миллисекунды.
   *
   * Считается по `questions.duration_ms` — от вставки строки до готового
   * текста, включая вызов модели. Это то время, которое человек проводит в
   * ожидании после `202`.
   */
  readonly question_p95_ms: number;
  /**
   * PDF разбора за сутки (1.6.8).
   *
   * `pdf_generated_24h` и `pdf_failed_24h` считаются по таблице `report_pdfs`
   * (`updated_at` — момент, когда строка стала `ready`/`failed`), а
   * `pdf_downloaded_24h` — по событиям: скачивание не меняет строку, только
   * увеличивает счётчик, и времени у него в таблице нет.
   *
   * `pdf_cost_rub_24h` — **ноль по построению**: документ собирается на CPU
   * нашим же кодом (reportlab + Pillow), модель не вызывается. Переменная
   * оставлена в контракте намеренно: если PDF когда-нибудь начнёт звать
   * модель (например, для вступления), стоимость должна появиться здесь, а не
   * в отдельном месте, о котором забыли.
   *
   * `pdf_build_p95_ms` — цена в другом смысле: время сборки. Для CPU-работы
   * это и есть «стоимость» — секунды сайдкара, которые кто-то ждёт.
   */
  readonly pdf_generated_24h: number;
  readonly pdf_downloaded_24h: number;
  readonly pdf_failed_24h: number;
  readonly pdf_cost_rub_24h: number;
  readonly pdf_build_p95_ms: number;
  /**
   * Сколько карточек шеринга собрано за сутки — по видам (итерация 37).
   *
   * По видам, а не одной цифрой: `day` и `wheel` — удержание (человек уже в
   * приложении), `identity` — повод показать себя после оплаты, `moon` — вход в
   * воронку без профиля. Одно число смешало бы три разных вопроса, и «карточек
   * стало больше» читалось бы как успех, даже если весь рост — `moon`.
   */
  readonly share_cards_created_24h: Readonly<Record<string, number>>;
  /** Утренний пуш (1.6.13): сколько сообщений ушло за сутки. */
  readonly push_sent_24h: number;
  /** Отправки, которые Bot API отверг (`blocked` и `chat not found` не в счёт). */
  readonly push_failed_24h: number;
  /**
   * Люди, которых пуш не достаёт из-за отсутствия пояса в карте.
   *
   * Это состояние, а не поток: один и тот же человек считается и завтра. Иначе
   * счётчик рос бы на 1440 в сутки (минута × сутки) и не значил бы ничего.
   */
  readonly push_skipped_no_tz_24h: number;
  /** Сколько раз уникальный ключ `push_log` предотвратил второй пуш за сутки. */
  readonly push_duplicate_prevented_24h: number;
  /**
   * Заявка в `push_log` была, отправки не было (1.6.14, долг 8.5).
   *
   * Строка создана до отправки (чтобы не отправить дважды), `error` пуст, но
   * `sent = false` — процесс умер между заявкой и вызовом Bot API. Ни
   * исключения, ни ошибки в журнале: без этого счётчика тихая потеря пушей
   * видна только по жалобам «а мне не пришло».
   */
  readonly push_claimed_not_sent_24h: number;
  /** Действующих прав доступа сейчас (подписка-грант, одноразовые — все). */
  readonly grants_active: number;
  /** Выдано прав за сутки — по источникам (`partner`, `founder`, `referral`, `admin`). */
  readonly grants_issued_24h: Readonly<Record<string, number>>;
  /**
   * Оценка упущенной выручки за сутки, рубли.
   *
   * Считается по каталогу: подаренные дни «всё включено» × месячная цена / 30,
   * выданные одноразовые права × их цена. Это **не** бухгалтерия: звёзды
   * пересчитаны в рубли по курсу из окружения (`STAR_RATE_RUB`), а не по
   * фактической выручке. Число нужно для одного вопроса: «сколько стоит акция
   * в месяц» — и оно должно быть сопоставимо с `BONUS_BUDGET_RUB`.
   */
  readonly grants_revenue_lost_rub_24h: number;
  /** Активаций кодов за сутки. */
  readonly codes_activated_24h: number;
  /** Пришло по приглашениям за сутки. */
  readonly referrals_joined_24h: number;
  /** Наград за приглашения начислено за сутки. */
  readonly referrals_rewarded_24h: number;
  /** Сколько мест основателей занято (из 50). */
  readonly founders_taken: number;
  /** Потрачено бюджета бесплатного доступа в этом месяце, рубли (1.6.14). */
  readonly bonus_budget_spent_rub: number;
  /** Лимит того же бюджета, рубли — из окружения (`BONUS_BUDGET_RUB`). */
  readonly bonus_budget_limit_rub: number;
}

/** Шаги воронки: ровно они попадают в `funnel_30d`. */
/**
 * Виды карточек шеринга в порядке контракта. Список нужен метрике, чтобы
 * «ноль по виду» был явным нулём, а не отсутствующим ключом.
 */
export const SHARE_CARD_KINDS = ['day', 'wheel', 'insight', 'identity', 'moon'] as const;

export const FUNNEL_STEPS = [
  'app_open',
  'consent_accepted',
  'chart_created',
  'checkout_opened',
  'payment_succeeded',
] as const;

const WINDOW = "interval '30 days'";
/** Время события: клиентское, а для серверных — время записи. */
const HAPPENED_AT = 'COALESCE(occurred_at, created_at)';

function ratio(part: number, total: number): number {
  return total === 0 ? 0 : Math.round((part / total) * 1000) / 1000;
}

@Injectable()
export class AdminMetricsService {
  constructor(
    @Inject(DbService) private readonly db: DbService,
    @Inject(APP_ENV) private readonly env: AppEnv,
    @Inject(TelegramWebhookService) private readonly webhook: TelegramWebhookService,
    @Inject(EngagementRepository) private readonly engagement: EngagementRepository,
    @Inject(BonusBudgetService) private readonly bonusBudget: BonusBudgetService,
  ) {}

  /**
   * Метрики бесплатного доступа (1.6.14) — одним запросом.
   *
   * `revenue_lost` считается здесь, а не в SQL: формула зависит от
   * `STAR_RATE_RUB` из окружения, и держать её в одном месте с остальными
   * метриками честнее, чем в подзапросе, который никто не найдёт.
   */
  private async grantMetrics(): Promise<{
    readonly active: number;
    readonly issuedBySource: Readonly<Record<string, number>>;
    readonly revenueLost: number;
    readonly codesActivated: number;
    readonly referralsJoined: number;
    readonly referralsRewarded: number;
    readonly foundersTaken: number;
    readonly daysGranted: number;
    readonly reportsGranted: number;
    readonly compatsGranted: number;
  }> {
    const row = await this.db.queryOne<{
      active: number;
      by_source: Record<string, number> | null;
      days_granted: number;
      reports_granted: number;
      compats_granted: number;
      codes_activated: number;
      referrals_joined: number;
      referrals_rewarded: number;
      founders_taken: number;
    }>(
      `SELECT
         (SELECT count(*)::int FROM grants
           WHERE revoked_at IS NULL
             AND ((kind = 'all_access' AND expires_at > now())
               OR (kind <> 'all_access' AND consumed_at IS NULL))) AS active,
         (SELECT COALESCE(jsonb_object_agg(source, total), '{}'::jsonb)
            FROM (SELECT source, count(*)::int AS total
                    FROM grants
                   WHERE created_at >= now() - interval '24 hours'
                   GROUP BY source) AS by_source) AS by_source,
         (SELECT COALESCE(SUM(days), 0)::int FROM grants
           WHERE kind = 'all_access' AND revoked_at IS NULL
             AND created_at >= now() - interval '24 hours') AS days_granted,
         (SELECT count(*)::int FROM grants
           WHERE kind = 'single_report' AND revoked_at IS NULL
             AND created_at >= now() - interval '24 hours') AS reports_granted,
         (SELECT count(*)::int FROM grants
           WHERE kind = 'single_compat' AND revoked_at IS NULL
             AND created_at >= now() - interval '24 hours') AS compats_granted,
         (SELECT count(*)::int FROM access_code_activations
           WHERE activated_at >= now() - interval '24 hours') AS codes_activated,
         (SELECT count(*)::int FROM referrals
           WHERE joined_at >= now() - interval '24 hours') AS referrals_joined,
         (SELECT count(*)::int FROM referrals
           WHERE rewarded_at >= now() - interval '24 hours') AS referrals_rewarded,
         (SELECT count(*)::int FROM founders) AS founders_taken`,
    );

    const daysGranted = row?.days_granted ?? 0;
    const reportsGranted = row?.reports_granted ?? 0;
    const compatsGranted = row?.compats_granted ?? 0;

    // Цены берём из каталога, а не из констант: метрика обязана меняться вместе
    // с ценой, иначе «потеряли 7 500 ₽» переживёт правку прайса.
    const prices = await this.db.queryOne<{ month: string | null; report: string | null; compat: string | null }>(
      `SELECT (SELECT stars::text FROM plans WHERE code = 'month_399') AS month,
              (SELECT stars::text FROM plans WHERE code = 'one_149') AS report,
              (SELECT stars::text FROM plans WHERE code = 'compat_249') AS compat`,
    );

    const rate = this.env.STAR_RATE_RUB;
    const monthStars = Number(prices?.month ?? '0');
    const reportStars = Number(prices?.report ?? '0');
    const compatStars = Number(prices?.compat ?? '0');

    // День «всё включено» по цене каталога: месяц / 30. Одноразовые права —
    // поштучно по своей цене. Всё умножается на курс звезды.
    const lostStars =
      (daysGranted * monthStars) / 30 + reportsGranted * reportStars + compatsGranted * compatStars;

    return {
      active: row?.active ?? 0,
      issuedBySource: row?.by_source ?? {},
      revenueLost: Math.round(lostStars * rate * 100) / 100,
      codesActivated: row?.codes_activated ?? 0,
      referralsJoined: row?.referrals_joined ?? 0,
      referralsRewarded: row?.referrals_rewarded ?? 0,
      foundersTaken: row?.founders_taken ?? 0,
      daysGranted,
      reportsGranted,
      compatsGranted,
    };
  }

  async getMetrics(): Promise<ProductMetrics> {
    const [
      activity,
      events,
      funnel,
      subscriptions,
      payments,
      reports,
      cost,
      history,
      compat,
      compatSections,
      compatHistory,
      telegramCancel,
      paymentHealth,
      daily,
      shareCards,
      pushLog,
      pushRuns,
      pushNoTz,
      grants,
    ] = await Promise.all([
        this.db.queryOne<{ mau: number }>(
          `SELECT count(DISTINCT user_id)::int AS mau
             FROM events
            WHERE user_id IS NOT NULL
              AND ${HAPPENED_AT} >= now() - ${WINDOW}`,
        ),
        this.db.query<{ name: string; total: number }>(
          `SELECT name, count(*)::int AS total
             FROM events
            WHERE ${HAPPENED_AT} >= now() - ${WINDOW}
            GROUP BY name
            ORDER BY total DESC`,
        ),
        this.db.query<{ name: string; users: number }>(
          `SELECT name, count(DISTINCT user_id)::int AS users
             FROM events
            WHERE user_id IS NOT NULL
              AND name = ANY($1::text[])
              AND ${HAPPENED_AT} >= now() - ${WINDOW}
            GROUP BY name`,
          [FUNNEL_STEPS],
        ),
        this.db.queryOne<{ paying: number; churned_30d: number; base: number }>(
          // Подписка, оплаченная тестовым тарифом, — не продажа: в `paying`
          // (а значит, и в конверсии) она не участвует. Признак берём с
          // платежа по charge_id подписки: у `subscriptions` своего флага нет
          // намеренно — «тестовость» это свойство платежа, а не доступа.
          `SELECT
             count(*) FILTER (
               WHERE s.status = 'active' AND s.expires_at > now() AND t.id IS NULL
             )::int AS paying,
             count(*) FILTER (
               WHERE s.status IN ('expired', 'cancelled')
                 AND s.updated_at >= now() - ${WINDOW}
                 AND t.id IS NULL
             )::int AS churned_30d,
             count(*) FILTER (WHERE t.id IS NULL)::int AS base
           FROM subscriptions s
           LEFT JOIN payments t
             ON t.telegram_payment_charge_id = s.telegram_payment_charge_id
            AND t.is_test`,
        ),
        this.db.queryOne<{
          stars: number;
          rejected: number;
          mismatch: number;
          refunded: number;
          pending: number;
          test: number;
        }>(
          // `rejected` — деньги не за доступ: в выручку не попадают (QA-11).
          // `is_test` исключён из всех денежных агрегатов: тестовая звезда
          // владельца — не выручка, не отказ и не «зависший платёж».
          `SELECT
             COALESCE(sum(total_amount) FILTER (
               WHERE status NOT IN ('refunded', 'rejected')
                 AND paid_at >= now() - ${WINDOW}
                 AND NOT is_test
             ), 0)::int AS stars,
             count(*) FILTER (
               WHERE status = 'rejected' AND paid_at >= now() - ${WINDOW} AND NOT is_test
             )::int AS rejected,
             count(*) FILTER (
               WHERE status = 'rejected' AND reject_reason = 'amount_mismatch'
                 AND paid_at >= now() - ${WINDOW} AND NOT is_test
             )::int AS mismatch,
             count(*) FILTER (
               WHERE status = 'refunded' AND refunded_at >= now() - ${WINDOW} AND NOT is_test
             )::int AS refunded,
             count(*) FILTER (
               WHERE ((status = 'paid' AND processed = false)
                  OR (status = 'rejected'
                      AND reject_reason IN ('invoice_invalidated', 'user_deleted')
                      AND refunded_at IS NULL))
                 AND NOT is_test
             )::int AS pending,
             count(*) FILTER (
               WHERE is_test AND paid_at >= now() - ${WINDOW}
             )::int AS test
           FROM payments`,
        ),
        this.db.queryOne<{ failed: number }>(
          // Только разборы: у совместимости своя цифра (`compat_failed_30d`).
          `SELECT count(*)::int AS failed
             FROM reports
            WHERE status = 'failed' AND kind = 'report'
              AND updated_at >= now() - ${WINDOW}`,
        ),
        this.db.queryOne<{ cost: string }>(
          `SELECT COALESCE(SUM(llm_cost_rub), 0)::text AS cost
             FROM reports
            WHERE created_at >= now() - ${WINDOW}`,
        ),
        // Серия провалов валидации — та же логика, что у брейкера в заказе.
        this.db.query<ReportHistoryRow>(
          `SELECT error_code, updated_at
             FROM reports
            WHERE kind = 'report'
            ORDER BY created_at DESC
            LIMIT 20`,
        ),
        // Совместимость: готовые и провалившиеся за 30 дней + остаток прав.
        this.db.queryOne<{ ready: number; failed: number; credits: number }>(
          `SELECT
             count(*) FILTER (WHERE status = 'ready')::int AS ready,
             count(*) FILTER (WHERE status = 'failed')::int AS failed,
             (
               (SELECT count(*) FROM entitlements
                 WHERE kind = 'compat' AND status = 'active' AND used_at IS NULL
                   AND (expires_at IS NULL OR expires_at > now()))
               +
               (SELECT count(*) FROM subscriptions s
                 WHERE s.status = 'active' AND s.expires_at > now()
                   AND NOT EXISTS (
                         SELECT 1 FROM reports r2
                          WHERE r2.user_id = s.user_id AND r2.kind = 'compat'
                            AND r2.status = 'ready'
                            AND COALESCE(r2.finished_at, r2.updated_at)
                                >= GREATEST(s.created_at, now() - interval '30 days')
                       ))
             )::int AS credits
           FROM reports
          WHERE kind = 'compat' AND created_at >= now() - ${WINDOW}`,
        ),
        // Обрезка и выбросы разделов за сутки (итерация 27). Источник —
        // сохранённые `normalization`/`section_status`: считать по логам
        // нельзя, логи не лежат в БД.
        this.db.queryOne<{ trimmed: number; dropped: number }>(
          `SELECT
             (SELECT count(*)::int
                FROM reports r,
                     jsonb_each(
                       CASE WHEN jsonb_typeof(r.normalization) = 'object'
                            THEN r.normalization ELSE '{}'::jsonb END
                     ) AS e(k, v)
               WHERE r.kind = 'compat'
                 AND r.created_at >= now() - interval '24 hours'
                 AND e.v -> 'normalized' ? 'trimmed') AS trimmed,
             (SELECT count(*)::int
                FROM reports r,
                     jsonb_each_text(
                       CASE WHEN jsonb_typeof(r.section_status) = 'object'
                            THEN r.section_status ELSE '{}'::jsonb END
                     ) AS e(k, v)
               WHERE r.kind = 'compat'
                 AND r.created_at >= now() - interval '24 hours'
                 AND e.v = 'failed') AS dropped`,
        ),
        // Свой счётчик брейкера: только `kind = 'compat'`.
        this.db.query<ReportHistoryRow>(
          `SELECT error_code, updated_at
             FROM reports
            WHERE kind = 'compat'
            ORDER BY created_at DESC
            LIMIT 20`,
        ),
        // Задача A: «повторяется в фоне» без числа — это «неизвестно, работает
        // ли». Первое — сколько отмен автопродления не прошло, второе —
        // сколько подписок всё ещё ждут повтора.
        this.db.queryOne<{
          failed: number;
          pending: number;
          cancelTotal: number;
          cancelFailed: number;
          noChargeId: number;
          autoRenewOff: number;
        }>(
          `SELECT
             (SELECT count(*)::int FROM events
               WHERE name = 'subscription_cancel_failed'
                 AND created_at >= now() - ${WINDOW}) AS failed,
             (SELECT count(*)::int FROM subscriptions
               WHERE telegram_cancel_state = 'failed') AS pending,
             (SELECT count(*)::int FROM events
               WHERE name = 'subscription_cancelled'
                 AND created_at >= now() - interval '24 hours') AS "cancelTotal",
             (SELECT count(*)::int FROM events
               WHERE name = 'subscription_cancel_failed'
                 AND created_at >= now() - interval '24 hours') AS "cancelFailed",
             (SELECT count(*)::int FROM events
               WHERE name = 'subscription_cancel_failed'
                 AND props ->> 'code' = 'no_charge_id'
                 AND created_at >= now() - interval '24 hours') AS "noChargeId",
             (SELECT count(*)::int FROM subscriptions
               WHERE status = 'active' AND expires_at > now()
                 AND auto_renew = false) AS "autoRenewOff"`,
        ),
        this.db.queryOne<{
          pre_checkout_total: number;
          pre_checkout_rejected: number;
          pre_checkout_timeout: number;
          successful_payment_total: number;
          payment_failed: number;
        }>(
          // Запрос платежа и его исход живут в разных таблицах: `pre_checkout_*`
          // приходит вебхуком и остаётся только событием, `successful_payment`
          // всегда оставляет строку в `payments`. Поэтому два подзапроса в
          // одном ответе — так обе половины считаются по одному «сейчас».
          `SELECT
             (SELECT count(*)::int FROM events
               WHERE name = 'pre_checkout_received'
                 AND ${HAPPENED_AT} >= now() - interval '24 hours') AS pre_checkout_total,
             (SELECT count(*)::int FROM events
               WHERE name = 'pre_checkout_rejected'
                 AND ${HAPPENED_AT} >= now() - interval '24 hours') AS pre_checkout_rejected,
             (SELECT count(*)::int FROM events
               WHERE name = 'pre_checkout_timeout'
                 AND ${HAPPENED_AT} >= now() - interval '24 hours') AS pre_checkout_timeout,
             (SELECT count(*)::int FROM payments
               WHERE paid_at >= now() - interval '24 hours') AS successful_payment_total,
             (SELECT count(*)::int FROM payments
               WHERE status = 'rejected' AND paid_at >= now() - interval '24 hours') AS payment_failed`,
        ),
        // Прогноз дня и «спроси карту» (итерация 30).
        this.db.queryOne<{
          forecastReady: number;
          forecastFailed: number;
          forecastFactsOnly: number;
          forecastCacheHits: number;
          forecastCost: string;
          questionsReady: number;
          questionsFailed: number;
          questionsRefused: number;
          questionsRefusedByReason: Record<string, number>;
          questionsCost: string;
          questionP95: number;
          compatFailed: number;
          compatCost: string;
          pdfGenerated: number;
          pdfDownloaded: number;
          pdfFailed: number;
          pdfBuildP95: number;
        }>(
          `SELECT
             (SELECT count(*)::int FROM events
               WHERE name = 'forecast_ready'
                 AND created_at >= now() - interval '24 hours') AS "forecastReady",
             (SELECT count(*)::int FROM events
               WHERE name = 'forecast_failed'
                 AND created_at >= now() - interval '24 hours') AS "forecastFailed",
             (SELECT count(*)::int FROM events
               WHERE name = 'forecast_facts_only'
                 AND created_at >= now() - interval '24 hours') AS "forecastFactsOnly",
             (SELECT count(*)::int FROM events
               WHERE name = 'forecast_cache_hit'
                 AND created_at >= now() - interval '24 hours') AS "forecastCacheHits",
             (SELECT COALESCE(SUM(cost_rub), 0)::text FROM daily_forecasts
               WHERE created_at >= now() - interval '24 hours') AS "forecastCost",
             (SELECT count(*)::int FROM questions
               WHERE status = 'ready'
                 AND created_at >= now() - interval '24 hours') AS "questionsReady",
             (SELECT count(*)::int FROM questions
               WHERE status = 'failed'
                 AND created_at >= now() - interval '24 hours') AS "questionsFailed",
             (SELECT count(*)::int FROM questions
               WHERE status = 'refused'
                 AND created_at >= now() - interval '24 hours') AS "questionsRefused",
             (SELECT COALESCE(jsonb_object_agg(reason, total), '{}'::jsonb)
                FROM (SELECT reason, count(*)::int AS total
                        FROM questions
                       WHERE status = 'refused' AND reason IS NOT NULL
                         AND created_at >= now() - interval '24 hours'
                       GROUP BY reason) AS by_reason) AS "questionsRefusedByReason",
             (SELECT COALESCE(SUM(cost_rub), 0)::text FROM questions
               WHERE created_at >= now() - interval '24 hours') AS "questionsCost",
             (SELECT COALESCE(percentile_cont(0.95)
                        WITHIN GROUP (ORDER BY duration_ms), 0)::int
                FROM questions
               WHERE duration_ms IS NOT NULL
                 AND created_at >= now() - interval '24 hours') AS "questionP95",
             (SELECT count(*)::int FROM reports
               WHERE kind = 'compat' AND status = 'failed'
                 AND updated_at >= now() - interval '24 hours') AS "compatFailed",
             (SELECT COALESCE(SUM(llm_cost_rub), 0)::text FROM reports
               WHERE kind = 'compat'
                 AND created_at >= now() - interval '24 hours') AS "compatCost",
             (SELECT count(*)::int FROM report_pdfs
               WHERE status = 'ready'
                 AND updated_at >= now() - interval '24 hours') AS "pdfGenerated",
             (SELECT count(*)::int FROM events
               WHERE name = 'pdf_downloaded'
                 AND created_at >= now() - interval '24 hours') AS "pdfDownloaded",
             (SELECT count(*)::int FROM report_pdfs
               WHERE status = 'failed'
                 AND updated_at >= now() - interval '24 hours') AS "pdfFailed",
             (SELECT COALESCE(percentile_cont(0.95)
                        WITHIN GROUP (ORDER BY build_ms), 0)::int
                FROM report_pdfs
               WHERE status = 'ready' AND build_ms IS NOT NULL
                 AND updated_at >= now() - interval '24 hours') AS "pdfBuildP95"`,
        ),
        // Карточки шеринга по видам (итерация 37). Считаются по `share_cards`:
        // строка там появляется только при реальной сборке, а кэш-попадание
        // свою строку не создаёт — значит «собрано», а не «запрошено».
        this.db.query<{ kind: string; total: number }>(
          `SELECT kind, count(*)::int AS total
             FROM share_cards
            WHERE created_at >= now() - interval '24 hours'
            GROUP BY kind`,
        ),
        // Утренний пуш (итерация 38). Три источника:
        //   • `push_log` — что реально ушло и что сломалось;
        //   • `push_runs` — защиты от дублей (их не видно в `push_log`, потому
        //     что проигравший гонку ничего не пишет);
        //   • карты без пояса — состояние «этих не достать никогда».
        this.engagement.pushLogTotals24h(),
        this.engagement.pushRunTotals24h(),
        this.engagement.countPushNoTz(),
        // Бесплатный доступ по праву (итерация 39). Один запрос на все семь
        // чисел: они читают одни и те же таблицы, а семь запросов в
        // `/admin/metrics` — это семь шансов на медленный ответ.
        this.grantMetrics(),
      ]);

    const eventsByName: Record<string, number> = {};
    for (const row of events) {
      eventsByName[row.name] = row.total;
    }

    // Нулевые шаги тоже отдаём: клиенту проще рисовать воронку без «дыр».
    const funnelByStep: Record<string, number> = {};
    for (const step of FUNNEL_STEPS) {
      funnelByStep[step] = funnel.find((row) => row.name === step)?.users ?? 0;
    }

    const paying = subscriptions?.paying ?? 0;
    const mau = activity?.mau ?? 0;

    const series = validationStreak(history);
    const breaker = breakerState(series.streak, series.lastFailedAt);
    // `reports_validation_streak` — наблюдение и растёт всегда, даже при
    // выключенном брейкере. А `reports_breaker_open` отвечает на вопрос
    // «закрыт ли приём прямо сейчас»: при `REPORT_BREAKER_ENABLED=0` он
    // закрыт не бывает, что бы ни показывала серия.
    const closed = this.env.REPORT_BREAKER_ENABLED === '1' && breaker.open;

    // Вебхук — не из БД, а из последней проверки при старте API: в промис-пул
    // не кладём, чтобы не смешивать запросы и состояние процесса.
    const webhook = this.webhook.health();

    // Бюджет бесплатного доступа (1.6.14) — отдельный вызов, потому что его же
    // читают `/health` и `AlertsService`: расчёт живёт в `BonusBudgetService`, а
    // не в трёх SQL-копиях.
    const budget = await this.bonusBudget.state();

    const compatSeries = validationStreak(compatHistory);
    const compatBreaker = breakerState(compatSeries.streak, compatSeries.lastFailedAt);
    const compatClosed = this.env.COMPAT_BREAKER_ENABLED === '1' && compatBreaker.open;

    return {
      mau,
      paying,
      conversion_to_paid: ratio(paying, mau),
      // Оценка: доля отписок среди всех подписок, а не когортный churn —
      // для когорт нужна история, которую начнём копить с этой версии.
      churn_30d: ratio(subscriptions?.churned_30d ?? 0, subscriptions?.base ?? 0),
      stars_received_30d: payments?.stars ?? 0,
      // Одна формула: рубли по цене модели (QA-002, задача 2).
      llm_cost_rub_30d: Math.round(Number(cost?.cost ?? 0) * 10_000) / 10_000,
      reports_failed_30d: reports?.failed ?? 0,
      reports_validation_streak: breaker.streak,
      reports_breaker_open: closed,
      reports_breaker_last_failed_at: breaker.last_failed_at,
      payments_rejected_30d: payments?.rejected ?? 0,
      amount_mismatch_30d: payments?.mismatch ?? 0,
      refunded_30d: payments?.refunded ?? 0,
      pending_payments_now: payments?.pending ?? 0,
      pre_checkout_total_24h: paymentHealth?.pre_checkout_total ?? 0,
      pre_checkout_rejected_24h: paymentHealth?.pre_checkout_rejected ?? 0,
      pre_checkout_timeout_24h: paymentHealth?.pre_checkout_timeout ?? 0,
      successful_payment_total_24h: paymentHealth?.successful_payment_total ?? 0,
      payment_failed_24h: paymentHealth?.payment_failed ?? 0,
      subscription_cancel_failed_30d: telegramCancel?.failed ?? 0,
      subscriptions_cancelled_pending_telegram: telegramCancel?.pending ?? 0,
      subscription_cancel_total_24h: telegramCancel?.cancelTotal ?? 0,
      subscription_cancel_failed_24h: telegramCancel?.cancelFailed ?? 0,
      subscription_cancel_no_charge_id_24h: telegramCancel?.noChargeId ?? 0,
      subscriptions_auto_renew_off: telegramCancel?.autoRenewOff ?? 0,
      test_payments_30d: payments?.test ?? 0,
      // Не из БД: это окружение процесса, поэтому метрика честна в ту же
      // секунду, когда флаг включили или сняли, — без ожидания платежа.
      test_plans_active: this.env.PAYMENTS_TEST_PLANS === '1',
      telegram_webhook_ok: webhook.ok,
      telegram_webhook_checked_at: webhook.checkedAt,
      events_30d: eventsByName,
      funnel_30d: funnelByStep,
      compat_ready_30d: compat?.ready ?? 0,
      compat_failed_30d: compat?.failed ?? 0,
      compat_credits_left: compat?.credits ?? 0,
      compat_validation_streak: compatBreaker.streak,
      compat_breaker_open: compatClosed,
      compat_sections_trimmed_24h: compatSections?.trimmed ?? 0,
      compat_sections_dropped_24h: compatSections?.dropped ?? 0,
      forecast_ready_24h: daily?.forecastReady ?? 0,
      forecast_failed_24h: daily?.forecastFailed ?? 0,
      forecast_facts_only_24h: daily?.forecastFactsOnly ?? 0,
      forecast_cache_hits_24h: daily?.forecastCacheHits ?? 0,
      forecast_cost_rub_24h: Math.round(Number(daily?.forecastCost ?? 0) * 10_000) / 10_000,
      questions_ready_24h: daily?.questionsReady ?? 0,
      questions_failed_24h: daily?.questionsFailed ?? 0,
      questions_refused_24h: daily?.questionsRefused ?? 0,
      questions_refused_by_reason: daily?.questionsRefusedByReason ?? {},
      compat_failed_24h: daily?.compatFailed ?? 0,
      compat_cost_rub_24h: Math.round(Number(daily?.compatCost ?? 0) * 10_000) / 10_000,
      questions_cost_rub_24h: Math.round(Number(daily?.questionsCost ?? 0) * 10_000) / 10_000,
      question_p95_ms: daily?.questionP95 ?? 0,
      pdf_generated_24h: daily?.pdfGenerated ?? 0,
      pdf_downloaded_24h: daily?.pdfDownloaded ?? 0,
      pdf_failed_24h: daily?.pdfFailed ?? 0,
      // Ноль — не «не посчитали», а факт: сборка PDF не тратит токенов.
      pdf_cost_rub_24h: 0,
      pdf_build_p95_ms: daily?.pdfBuildP95 ?? 0,
      // Все пять видов в ответе всегда: ноль — это «не создавали», и он
      // осмысленнее пропущенного ключа, по которому нельзя построить график.
      push_sent_24h: pushLog.sent,
      push_failed_24h: pushLog.failed,
      push_skipped_no_tz_24h: pushNoTz,
      push_duplicate_prevented_24h: pushRuns.duplicatePrevented,
      push_claimed_not_sent_24h: pushLog.claimedNotSent,
      grants_active: grants.active,
      grants_issued_24h: grants.issuedBySource,
      grants_revenue_lost_rub_24h: grants.revenueLost,
      codes_activated_24h: grants.codesActivated,
      referrals_joined_24h: grants.referralsJoined,
      referrals_rewarded_24h: grants.referralsRewarded,
      founders_taken: grants.foundersTaken,
      // Бюджет бесплатного доступа — тем же числом, что в `/health` и в алерте:
      // один расчёт на три места, иначе «исчерпан» в `/health` и в алерте
      // разойдётся на границе месяца.
      bonus_budget_spent_rub: budget.spent_rub,
      bonus_budget_limit_rub: budget.limit_rub,
      share_cards_created_24h: SHARE_CARD_KINDS.reduce<Record<string, number>>(
        (totals, kind) => {
          totals[kind] = shareCards.find((row) => row.kind === kind)?.total ?? 0;
          return totals;
        },
        {},
      ),
    };
  }
}
