import { Inject, Injectable } from '@nestjs/common';
import type { GrantKind } from '@astro-soul/shared';
import { DbService } from '../../db/db.service';
import { GrantsRepository } from '../grants/grants.repository';
import { EntitlementsService } from './entitlements.service';

/**
 * `hasAccess(userId, feature)` — единственная дверь к доступу (контракт 1.6.14).
 *
 * До итерации 39 проверок было три вида, и каждая жила там, где понадобилась:
 *   • `entitlements.isActive` (подписка) — прогноз, вопросы;
 *   • `entitlements` строка на карту — разбор;
 *   • `subscriptions` напрямую — совместимость.
 * Из этого следовало, что новый источник прав надо прикручивать в трёх местах
 * и легко забыть четвёртое. Теперь источники (подписка, разовые покупки,
 * гранты) складываются **внутри** `EntitlementsService`, а маршруты спрашивают
 * только `hasAccess`.
 *
 * Почему ни один маршрут не может «обойти» эту функцию:
 *   • гранты не попадают ни в `subscriptions`, ни в `plans`, поэтому старые
 *     проверки `subscriptions` без неё просто не увидят подарок — то есть
 *     маршрут, забывший `hasAccess`, ломается **в пользу отказа**, а не в
 *     пользу лишнего доступа (fail-closed);
 *   • прямая проверка `subscriptions` запрещена тестом
 *     `grants-access-guard.spec.ts`: он ищет такие запросы вне
 *     `billing/`, `ops/`, `entitlements/` и репозиториев;
 *   • разовые права гасятся атомарно (`consumeSingle`), поэтому «две кнопки
 *     одновременно» не дают двух бесплатных разборов.
 */
export type AccessFeature =
  /** Полный прогноз дня (иначе — короткая бесплатная версия). */
  | 'full_forecast'
  /** «Спроси карту». */
  | 'ask'
  /** Полный разбор (с картой — разбор именно этой карты). */
  | 'report'
  /** Совместимость с партнёром. */
  | 'compat'
  /** Карта года. */
  | 'solar';

/**
 * Почему разбор доступен (контракт 1.6.19, `Me.report_access.source`).
 *
 * Порядок приоритета зафиксирован и проверяется тестом: `purchased` →
 * `all_access` → `single_report`. Клиент показывает разный текст («куплено»,
 * «входит в подарок», «осталось N бесплатных»), поэтому источник — часть
 * контракта, а не деталь реализации.
 */
export type ReportAccessSource = 'purchased' | 'all_access' | 'single_report';

/**
 * Ответ на вопрос «можно ли человеку разбор» — в одном объекте.
 *
 * `available` — это **право** (можно заказать или открыть разбор сейчас),
 * `chartId` — карта, за которую разбор уже оплачен (или по которой он готов).
 * Это разные вопросы: у владельца «всё включено» право есть, а оплаченной
 * карты нет (1.6.19, дефект round44: `full_report = true` при `chart_id = null`
 * читался клиентом как «оплачено на этой карте»).
 */
export interface ReportAccess {
  readonly available: boolean;
  readonly source: ReportAccessSource | null;
  /** Конец права «всё включено»; у покупки/подарка срока нет — `null`. */
  readonly expiresAt: string | null;
  /** Карта, за которую разбор оплачен/готов; `null` — привязки к карте нет. */
  readonly chartId: string | null;
}

/** «Разбора нет» — одно значение на все отказы, чтобы не плодить `null`-и. */
const NO_REPORT_ACCESS: ReportAccess = {
  available: false,
  source: null,
  expiresAt: null,
  chartId: null,
};

export interface AccessCheckOptions {
  /** Для `report`: карта, за которую спрашиваем. */
  readonly chartId?: string;
  /**
   * Для `report`/`compat`: списать одноразовое право при успехе.
   *
   * `false` (по умолчанию) — «можно ли?», без побочных эффектов: так спрашивают
   * экраны. `true` — «можно и вот тебе право»: так спрашивает создание заказа.
   */
  readonly consume?: boolean;
}

@Injectable()
export class AccessService {
  constructor(
    @Inject(DbService) private readonly db: DbService,
    @Inject(EntitlementsService) private readonly entitlements: EntitlementsService,
    @Inject(GrantsRepository) private readonly grants: GrantsRepository,
  ) {}

  /**
   * Бан проверяется **первым** и до подписки, грантов и разовых прав (1.6.16).
   *
   * Почему здесь, а не в каждом маршруте: `hasAccess` — единственная дверь, и
   * проверка выше источников прав означает, что забаненный не получает доступ
   * даже с действующей подпиской и подаренным грантом. Порядок важен
   * буквально: если поставить бан после `getEntitlements`, запрос уже прочитал
   * бы права и мог бы (в будущем рефакторинге) вернуть `true` по одной из
   * веток. Здесь отказ — первое, что происходит.
   *
   * Бан **не** меняет ни `subscriptions`, ни `grants`, ни `entitlements`:
   * покупки остаются покупками, а решение «пускать или нет» принимается над
   * ними. Поэтому же разбан возвращает доступ без повторной оплаты.
   */
  async isBanned(userId: string): Promise<boolean> {
    const row = await this.db.queryOne<{ banned_at: Date | null }>(
      `SELECT banned_at FROM users WHERE id = $1`,
      [userId],
    );

    return row?.banned_at !== null && row?.banned_at !== undefined;
  }

  async hasAccess(
    userId: string,
    feature: AccessFeature,
    options: AccessCheckOptions = {},
  ): Promise<boolean> {
    if (await this.isBanned(userId)) {
      return false;
    }

    // `report` больше не нужен `getEntitlements` (1.6.19): решение принимает
    // `reportAccess`, который сам смотрит на покупку, готовый разбор, «всё
    // включено» и подаренные разборы. Флаг `fullReport` — витрина, а не дверь.
    if (feature === 'report') {
      const access = await this.reportAccess(userId, options);

      if (!access.available) {
        return false;
      }

      // Списывается только подаренный разбор и только по явному требованию
      // (`consume: true`). Оплаченный разбор и «всё включено» не расходуются:
      // первые — покупка, второе — срок, а не счётчик.
      if (options.consume !== true || access.source !== 'single_report') {
        return true;
      }

      return this.consume(userId, 'single_report', options.chartId);
    }

    const rights = await this.entitlements.getEntitlements(userId);

    switch (feature) {
      case 'full_forecast':
        return rights.fullForecast;
      case 'ask':
        // `askPerDay = -1` — без лимита, `0` — нельзя. Знак здесь не важен,
        // важно «есть ли вообще право спрашивать».
        //
        // `isActive` обязателен отдельно: у бесплатного уровня `askPerDay = 1`
        // как «один вопрос в подарок» ещё с первых итераций, и без этой
        // проверки `hasAccess('ask')` открыл бы вопросы всем подряд — что и
        // случилось при переходе с `entitlements.isActive` на дверь (тест
        // `questions.spec.ts` поймал это первым).
        return rights.isActive && rights.askPerDay !== 0;
      case 'solar':
        return rights.solarIncluded;
      case 'compat':
        return this.compatAccess(userId, rights.compatPerMonth, options.consume === true);
    }
  }

  /**
   * Разбор: право, его источник и карта — **одна** функция (контракт 1.6.19).
   *
   * Зачем: до 1.6.19 ответ «можно ли заказать разбор» собирался в двух местах —
   * в `hasAccess` (по флагу `entitlements.fullReport`) и в `Me` (по тем же
   * флагам, но иначе). Из-за этого владелец «всё включено» видел в `/me`
   * «разбор куплен», а `POST /reports` отвечал `402 report_not_paid`.
   *
   * Порядок источников фиксирован: купленный/готовый разбор этой карты →
   * действующее «всё включено» → неизрасходованный бесплатный разбор. Он важен
   * не только для текста на экране: `single_report` — расходуемое право, и
   * списывать его, когда разбор уже оплачен, значит брать деньги дважды.
   */
  async reportAccess(userId: string, options: AccessCheckOptions = {}): Promise<ReportAccess> {
    if (await this.isBanned(userId)) {
      return NO_REPORT_ACCESS;
    }

    const chartId = options.chartId;

    // 1. Оплаченный разбор. С картой — только эта карта (одна покупка не
    //    открывает разборы по другим: это деньги). Без карты — «есть оплаченный
    //    разбор вообще», но привязку не выдаём: показывать `chart_id` чужой
    //    карты в `/me` значило бы обещать разбор не по той карте.
    if (chartId !== undefined) {
      if (await this.reportPaidFor(userId, chartId)) {
        return { available: true, source: 'purchased', expiresAt: null, chartId };
      }
    } else if ((await this.entitlements.fullReportChartId(userId)) !== null) {
      return { available: true, source: 'purchased', expiresAt: null, chartId: null };
    }

    const rights = await this.entitlements.getGrantEntitlements(userId);

    // 2. «Всё включено» — право на разбор любой карты, но не покупка: `chartId`
    //    остаётся `null`, иначе клиент считает карту оплаченной (round44).
    if (rights.allAccessUntil !== null) {
      return {
        available: true,
        source: 'all_access',
        expiresAt: rights.allAccessUntil,
        chartId: null,
      };
    }

    // 3. Бесплатный разбор от кода/партнёра. Срок у него не показываем: право
    //    живёт до использования, а не до даты.
    if (rights.singleReports > 0) {
      return { available: true, source: 'single_report', expiresAt: null, chartId: null };
    }

    return NO_REPORT_ACCESS;
  }

  /**
   * Сколько подаренных одноразовых совместимостей осталось.
   *
   * Нужно экрану списка: окно подписки считается по `quotaOf`, а подаренное
   * право — отдельная строка в `grants`, и «кнопка закрыта, хотя право есть»
   * был бы дефектом отображения.
   */
  async singleCompatLeft(userId: string): Promise<number> {
    const rights = await this.entitlements.getGrantEntitlements(userId);
    return rights.singleCompat;
  }

  /**
   * Списать **только** подаренное право совместимости.
   *
   * Отдельный метод, а не `hasAccess('compat', {consume: true})`: подписка даёт
   * совместимость по окну (`quotaOf`), и «списать» её нельзя — иначе подписчик
   * с подарком терял бы подарок при первом же заказе по подписке.
   */
  async consumeSingleCompat(userId: string): Promise<boolean> {
    const rights = await this.entitlements.getGrantEntitlements(userId);

    if (rights.singleCompat === 0) {
      return false;
    }

    return this.consume(userId, 'single_compat');
  }

  /**
   * Списать одноразовое право на разбор (1.6.17).
   *
   * Отдельный метод, а не `hasAccess('report', {consume: true})`, потому что
   * расход теперь происходит **на `ready`**, а не на заказе (см.
   * `ReportsService`): проверка доступа к моменту генерации уже прошла, и
   * списывать право должен тот, кто довёл разбор до текста. Иначе провал
   * генерации сжигал подаренное право — а обещание было «право на разбор», не
   * «право на попытку».
   *
   * `chartId` нужен, чтобы материализовать `entitlements` строку: по ней потом
   * работает проверка PDF и `is_paid` (та же логика, что была у `consume`).
   */
  async consumeSingleReport(userId: string, chartId: string | undefined): Promise<boolean> {
    const rights = await this.entitlements.getGrantEntitlements(userId);

    if (rights.singleReports === 0) {
      return false;
    }

    return this.consume(userId, 'single_report', chartId);
  }

  /**
   * Совместимость: подписка/право «всё включено» (одна в 30 дней) **или**
   * разовый кредит, купленный или подаренный.
   *
   * `hasAccess` отвечает на вопрос «есть ли у человека какое-то право», а не
   * «открыто ли окно»: окно считается в `compat-quota.ts` по периоду доступа и
   * последней готовой совместимости. Поэтому здесь `compatPerMonth > 0` и
   * означает «право есть», даже если окно ещё закрыто.
   */
  private async compatAccess(
    userId: string,
    perMonth: number,
    consume: boolean,
  ): Promise<boolean> {
    if (perMonth > 0) {
      return true;
    }

    const rights = await this.entitlements.getGrantEntitlements(userId);

    if (rights.singleCompat === 0) {
      return false;
    }

    if (!consume) {
      return true;
    }

    return this.consumeSingleCompat(userId);
  }

  /**
   * Атомарный расход одного права. Вторая попытка «одновременно» права не
   * получит.
   *
   * Потраченное право на разбор **материализуется** в `entitlements`
   * (`kind = 'report'`, `chart_id`, без `payment_id`): дальше работает вся
   * существующая логика оплаченного разбора — `is_paid`, PDF, повторный
   * `GET /reports/{id}`. Без этой строки человек с бесплатным разбором не смог
   * бы скачать PDF: проверка PDF смотрит именно на право по карте.
   *
   * `entitlements` — не подписка: здесь нет ни `charge_id`, ни автопродления,
   * поэтому алерт `subscription_cancel_no_charge_id_24h` эту строку не увидит.
   */
  private async consume(
    userId: string,
    kind: Exclude<GrantKind, 'all_access'>,
    chartId: string | undefined = undefined,
  ): Promise<boolean> {
    return this.db.withTransaction(async (client) => {
      const row = await this.grants.consumeSingle(client, userId, kind);

      if (row === null) {
        return false;
      }

      if (kind === 'single_report' && chartId !== undefined) {
        await client.query(
          `INSERT INTO entitlements (user_id, kind, chart_id, status)
           VALUES ($1, 'report', $2, 'active')`,
          [userId, chartId],
        );
      }

      return true;
    });
  }

  /** Активная покупка разбора именно этой карты (`entitlements`, не `subscriptions`). */
  async reportPaidFor(userId: string, chartId: string): Promise<boolean> {
    const row = await this.db.queryOne<{ one: number }>(
      `SELECT 1 AS one FROM entitlements
        WHERE user_id = $1 AND kind = 'report' AND status = 'active'
          AND chart_id = $2 AND (expires_at IS NULL OR expires_at > now())
        LIMIT 1`,
      [userId, chartId],
    );

    return row !== null;
  }

  /**
   * Период доступа для совместимости: подписка **или** право «всё включено».
   *
   * Возвращается именно период (`startedAt`/`expiresAt`), а не флаг: окно
   * «одна совместимость в 30 дней» считается от начала и от последней готовой,
   * и подменить его флагом значило бы вернуть дефект итерации 23 (окно
   * сбрасывалось раньше срока).
   */
  async accessPeriod(
    userId: string,
  ): Promise<{ startedAt: Date; expiresAt: Date } | null> {
    const subscription = await this.db.queryOne<{ created_at: Date; expires_at: Date }>(
      `SELECT created_at, expires_at FROM subscriptions
        WHERE user_id = $1 AND status = 'active' AND expires_at > now()`,
      [userId],
    );

    if (subscription !== null) {
      return { startedAt: subscription.created_at, expiresAt: subscription.expires_at };
    }

    const grant = await this.grants.activeAllAccess(userId);

    if (grant === null || grant.expires_at === null || grant.starts_at === null) {
      return null;
    }

    return { startedAt: grant.starts_at, expiresAt: grant.expires_at };
  }
}
