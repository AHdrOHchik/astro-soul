import { Inject, Injectable } from '@nestjs/common';
import { ApiError, notFound } from '../../common/api-error';
import { JsonLogger } from '../../common/logger';
import { pageLimit, pageOffset } from '../../common/paging';
import { findNearestCity, type GeoPlace } from '@astro-soul/shared';
import { APP_ENV } from '../../config/env.module';
import type { AppEnv } from '../../config/env';
import { DbService } from '../../db/db.service';
import type { VerifiedInitData } from '../auth/init-data';
import { AstroClient, type AstroChartData } from '../astro/astro.client';
import { LLM_PROVIDER } from '../llm/llm.module';
import { LlmError, type LlmMessage, type LlmProvider, type LlmResponse } from '../llm/llm.client';
import { UsersRepository } from '../users/users.repository';
import { breakerState, BREAKER_THRESHOLD, type BreakerState } from '../reports/breaker';
import type { FailureCode } from '../reports/failure-codes';
import { MAX_ATTEMPTS, RAW_EXCERPT_LENGTH } from '../reports/reports.service';
import {
  COMPAT_FACTS_VERSION,
  factsBlock,
  factorLine,
  factorsOf,
  parseCompatibilityFacts,
  type CompatibilityFacts,
} from './compat-facts';
import { coverageOf, distributeSections, MAX_SECTIONS_PER_FACTOR } from './compat-focus-map';
import { COMPAT_PROMPT_VERSION, COMPAT_SYSTEM_PROMPT, compatSectionPrompt } from './compat-prompts';
import { parseCompatRequest, compatRefused, type Relationship } from './compat.dto';
import { CompatRepository, type CompatReportRow, type CompatSection } from './compat.repository';
import {
  COMPAT_ACCEPT_MIN_CHARS,
  COMPAT_CONTRACT_WARNINGS,
  COMPAT_RANGES,
  COMPAT_SECTIONS,
  COMPAT_SECTION_TITLES,
  COMPAT_STRUCTURE_VERSION,
  finalizeSection,
  normalizeCompatSection,
  trimCompatSection,
  validateCompatSection,
  type CompatCheck,
  type CompatSectionKey,
  type CompatWarning,
} from './compat-validators';
import { quotaOf, type CompatQuota } from './compat-quota';
import { parseIdempotencyKey } from '../reports/reports.dto';

/** Сколько заказов совместимости отдаётся за один листинг. */
export const COMPAT_PAGE_MAX = 20;

/**
 * Потолок стоимости одной совместимости по умолчанию, рубли.
 *
 * Значение живёт в `LLM_COMPAT_CAP_RUB` (`env.ts`), константа — только его
 * документация и дефолт окружения. В расчёте используется переменная, чтобы
 * стенд мог поставить меньший потолок.
 */
export const COMPAT_CAP_RUB = 25;

/** Статус в контракте: `queued|planning|writing` — это `pending`. */
type CompatStatus = 'pending' | 'ready' | 'failed';

export interface CompatSectionView {
  readonly key: string;
  readonly title: string;
  readonly order: number;
  readonly text: string;
}

export interface CompatWarningView {
  readonly section: string;
  readonly code: string;
}

/** Тело ответа `GET /compatibility/{id}` (контракт 1.6.0). */
export interface CompatibilityView {
  readonly id: string;
  readonly status: CompatStatus;
  readonly sections: readonly CompatSectionView[];
  readonly warnings: readonly CompatWarningView[];
  readonly created_at: string;
  readonly error_code?: string;
}

/** Элемент `GET /compatibility` — без текста: список не должен весить мегабайт. */
export interface CompatibilityListItem {
  readonly id: string;
  readonly status: CompatStatus;
  readonly relationship: Relationship | null;
  readonly created_at: string;
  readonly titles_only: readonly string[];
}

export interface CompatibilityListView {
  readonly items: readonly CompatibilityListItem[];
  readonly quota: CompatQuota;
  /** Сколько заказов всего (после фильтра, до `LIMIT`). */
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
}

/** Ответ `POST /compatibility` — 202 и ничего лишнего. */
export interface CompatibilityAccepted {
  readonly compatibility_id: string;
  readonly status: 'pending';
}

/**
 * Куда попадает `error_code`. Внешние причины (`timeout`, `rate_limited`,
 * `auth`, `tls`, `config`) приходят из `LlmError` и пишутся как есть: по ним
 * поддержка отличает «модель не ответила» от «текст не прошёл валидатор».
 */
type CompatFailureCode =
  | FailureCode
  | 'provider'
  | 'cost_cap'
  | 'monthly_cap'
  | 'chart_missing'
  | 'engine'
  | 'timeout'
  | 'rate_limited'
  | 'auth'
  | 'tls'
  | 'config';

class CompatFailure extends Error {
  constructor(readonly code: CompatFailureCode) {
    super(code);
    this.name = 'CompatFailure';
  }
}

interface Budget {
  readonly compatibilityId: string;
  costRub: number;
  attempts: number;
}

interface ValidationEntry {
  readonly key: string;
  readonly attempt: number;
  readonly code: string;
  readonly severity: 'error' | 'warning';
  readonly failures: readonly string[];
  readonly chars: number;
  /**
   * Границы раздела и вердикт длины (итерация 27).
   *
   * Без `min`/`max` по логу нельзя понять, с чем сравнивали: живой прогон
   * `541d56a4` показал `too_short chars=1423`, и вопрос «а максимум-то какой»
   * повис в воздухе. Диагностика обязана содержать границы.
   */
  readonly min: number;
  readonly max: number;
  readonly verdict: string;
  /** Коды предупреждений этой попытки — в том числе `partner_pronoun`. */
  readonly warnings: readonly string[];
  /**
   * Перечень проверок с вердиктами (итерация 28): `length: ok`,
   * `steps_count: fail`, `ui_reference: warn` и так далее.
   *
   * Раньше запись выглядела как `code: "format"`, `verdict: "ok"`,
   * `failures: ["steps_count"]` — три поля, противоречащих друг другу.
   */
  readonly checks: readonly CompatCheck[];
  /** Что именно нашла каждая пометка: `{код: слово}`. */
  readonly warnings_matched: Readonly<Record<string, string>>;
  /** Длина объёма без подписи — по ней считается вердикт длины. */
  readonly volume_chars: number;
  /**
   * Что сделала обрезка на этой попытке (итерация 28).
   *
   * Раньше обрезка жила только в логе: по записи `validation` нельзя было
   * понять, что текст сначала порезали. В живом прогоне `46d8b893` из-за
   * этого 474 и 553 выглядели как противоречие, а не как «обрезали, потом
   * собрали заново».
   */
  readonly trimmed?: { readonly from: number; readonly to: number; readonly boundary: string };
  readonly raw_excerpt?: string;
}

type SectionWrite =
  | {
      readonly ok: true;
      /** Ровно та строка, что уйдёт в БД и человеку. */
      readonly body: string;
      readonly chars: number;
      readonly regenerated: boolean;
      readonly normalized: readonly string[];
      readonly warnings: readonly CompatWarning[];
    }
  | {
      readonly ok: false;
      readonly code: FailureCode;
      /** Почему раздел не отдан: пусто, не разобрано или запрещённый текст. */
      readonly reason: 'empty_response' | 'unparsed' | 'unsafe';
    };

/**
 * Что именно нашла каждая пометка: `{ui_reference: "нажми"}`.
 *
 * Без этого `matched` живёт только в `reports.validation`, а по логу нельзя
 * понять, ложное срабатывание или настоящее: в живом прогоне `46d8b893` код
 * `ui_reference` пришёл без слова.
 */
function matchedOf(warnings: readonly CompatWarning[]): Record<string, string> {
  const matched: Record<string, string> = {};
  for (const warning of warnings) {
    if (warning.matched !== undefined) {
      matched[warning.code] = warning.matched;
    }
  }
  return matched;
}

/**
 * Что нашла любая проверка — и провал, и пометка: `{ui_reference: "нажми"}`.
 *
 * `warnings_matched` покрывает только пометки, поэтому у провала
 * (`failures: ["ui_reference"]`) слова не было — а без слова код не
 * диагностируется.
 */
function matchedOfChecks(checks: readonly CompatCheck[]): Record<string, string> {
  const matched: Record<string, string> = {};
  for (const check of checks) {
    if (check.matched !== undefined) {
      matched[check.code ?? check.rule] = check.matched;
    }
  }
  return matched;
}

/**
 * Вердикты проверок одним объектом: `{length: "ok", steps_count: "fail"}`.
 *
 * В лог идут все проверки, а не только провалы: иначе «verdict ok при
 * code format» не различить, и диагностика противоречит сама себе.
 */
function verdictsOf(checks: readonly CompatCheck[]): Record<string, string> {
  const verdicts: Record<string, string> = {};
  for (const check of checks) {
    verdicts[check.rule] = check.status;
  }
  return verdicts;
}

/** Пунктов в `steps` — числом для лога: `items: 3`. */
function countStepsItems(text: string): number {
  return text.split('\n').filter((line) => line.trim().startsWith('—')).length;
}

/**
 * Конвейер совместимости.
 *
 * Тот же, что у разбора (очередь, блокировка, две попытки на раздел, свой
 * брейкер), но с тремя отличиями, каждое из которых — требование владельца:
 *
 *   1. Данные партнёра живут только в `compat_partners` и не покидают API:
 *      в модель уходят `compatibility_facts`, где нет ни даты, ни места.
 *   2. Квота списывается **только** при `ready`. Провал не списывает ничего,
 *      поэтому «возврат кредита» — это отсутствие операции, а не второй джоб.
 *   3. Факты распределяются детерминированно, и один факт звучит максимум в
 *      двух разделах (`MAX_SECTIONS_PER_FACTOR`).
 */
@Injectable()
export class CompatService {
  constructor(
    @Inject(CompatRepository) private readonly repo: CompatRepository,
    @Inject(DbService) private readonly db: DbService,
    @Inject(UsersRepository) private readonly users: UsersRepository,
    @Inject(AstroClient) private readonly astro: AstroClient,
    @Inject(LLM_PROVIDER) private readonly llm: LlmProvider,
    @Inject(APP_ENV) private readonly env: AppEnv,
    @Inject(JsonLogger) private readonly logger: JsonLogger,
  ) {}

  async order(
    auth: VerifiedInitData,
    idempotencyHeader: string | undefined,
    body: unknown,
  ): Promise<CompatibilityAccepted> {
    const idempotencyKey = parseIdempotencyKey(idempotencyHeader);
    const input = parseCompatRequest(body);
    const userId = this.users.userIdFor(auth.telegramUserId);

    const chart = await this.repo.chartForUser(input.chart_id, userId);
    if (chart === null) {
      throw notFound({ message: 'Такой карты нет. Построй карту заново', reason: 'chart_not_found' });
    }

    // Повтор с тем же ключом отдаёт тот же заказ: идемпотентность важнее
    // квоты — человек уже заплатил, второй раз платить ему не за что.
    const byKey = await this.repo.findByIdempotencyKey(userId, idempotencyKey);
    if (byKey !== null) {
      return { compatibility_id: byKey.id, status: 'pending' };
    }

    const breaker = await this.breaker();
    if (this.env.COMPAT_BREAKER_ENABLED === '1' && breaker.open) {
      this.logger.warn('compat_breaker_open', {
        streak: breaker.streak,
        threshold: BREAKER_THRESHOLD,
        retry_after_ms: breaker.retry_after_ms,
      });
      throw new ApiError('UPSTREAM_LLM', 503, {
        message: 'Совместимости временно не собираются — мы уже разбираемся. Попробуй позже',
        reason: 'compat_breaker_open',
        details: { reason: 'compat_breaker_open', retry_after_ms: breaker.retry_after_ms },
      });
    }

    const partner = this.partnerInput(input);
    const subscription = await this.repo.subscription(userId);
    const lastReadyAt = await this.repo.lastReadyAt(userId);

    // Проверка квоты и создание заказа — в одной транзакции. Иначе два
    // одновременных нажатия проходят проверку оба, и человек получает две
    // совместимости за одну покупку.
    const created = await this.db.withTransaction(async (client) => {
      const inflight = await this.repo.inFlight(client, userId);
      const credit = await this.repo.unusedPurchase(client, userId);

      if (inflight > 0) {
        throw compatRefused({
          reason: 'compat_already_owned',
          message: 'Совместимость по этой карте уже собирается — дождись её',
          field: 'chart_id',
        });
      }

      if (credit === null) {
        const quota = quotaOf({
          purchaseCredit: false,
          subscription:
            subscription === null
              ? null
              : { startedAt: subscription.created_at, expiresAt: subscription.expires_at },
          lastReadyAt,
        });

        if (quota.kind === 'none') {
          throw new ApiError('PAYMENT_REQUIRED', 402, {
            message: 'Совместимость — отдельная покупка или подписка',
            reason: 'compat_not_paid',
            details: {
              reason: 'compat_not_paid',
              field_errors: [{ field: 'chart_id', message: 'Нет права на совместимость' }],
            },
          });
        }

        if (quota.left === 0) {
          throw compatRefused({
            reason: 'compat_quota_exhausted',
            message: 'Совместимость по подписке уже собрана — следующая после сброса окна',
            field: 'chart_id',
            resetsAt: quota.resets_at,
          });
        }
      }

      const partnerId = await this.repo.createPartner(client, userId, partner);
      return this.repo.createReport(client, {
        chartId: chart.id,
        userId,
        idempotencyKey,
        model: this.llm.name,
        promptVersion: COMPAT_PROMPT_VERSION,
        structureVersion: COMPAT_STRUCTURE_VERSION,
        factsVersion: COMPAT_FACTS_VERSION,
        partnerId,
        creditEntitlementId: credit?.id ?? null,
      });
    });

    this.logger.info('compat_queued', {
      compatibility_id: created.id,
      relationship: input.relationship,
      model: this.llm.name,
    });

    void this.run(created.id).catch((error: unknown) => {
      this.logger.error('compat_runner_crashed', {
        compatibility_id: created.id,
        error: error instanceof Error ? error.message : String(error),
      });
    });

    return { compatibility_id: created.id, status: 'pending' };
  }

  async get(auth: VerifiedInitData, compatibilityId: string): Promise<CompatibilityView> {
    const userId = this.users.userIdFor(auth.telegramUserId);
    const row = await this.repo.owned(compatibilityId, userId);

    if (row === null) {
      throw notFound({ message: 'Такой совместимости нет. Обнови приложение', reason: 'compatibility_not_found' });
    }

    return this.view(row);
  }

  async list(
    auth: VerifiedInitData,
    limit?: string,
    offset?: string,
  ): Promise<CompatibilityListView> {
    const userId = this.users.userIdFor(auth.telegramUserId);
    const size = pageLimit(limit, COMPAT_PAGE_MAX);
    const skip = pageOffset(offset);
    const rows = await this.repo.listForUser(userId, size, skip);
    const total = await this.repo.countForUser(userId);

    const [credit, subscription, lastReadyAt] = await Promise.all([
      this.repo.hasActivePurchase(userId),
      this.repo.subscription(userId),
      this.repo.lastReadyAt(userId),
    ]);

    const quota = quotaOf({
      purchaseCredit: credit,
      subscription:
        subscription === null
          ? null
          : { startedAt: subscription.created_at, expiresAt: subscription.expires_at },
      lastReadyAt,
    });

    return {
      items: rows.map((row) => ({
        id: row.id,
        status: this.statusOf(row),
        relationship: row.relationship,
        created_at: row.created_at.toISOString(),
        titles_only: this.statusOf(row) === 'ready' ? this.titlesOf(row) : [],
      })),
      quota,
      total,
      limit: size,
      offset: skip,
    };
  }

  /** Состояние брейкера совместимости — только по `kind = 'compat'`. */
  async breaker(): Promise<BreakerState> {
    const { streak, lastFailedAt } = await this.repo.validationStreak();
    return breakerState(streak, lastFailedAt);
  }

  // --- конвейер ------------------------------------------------------------

  private async run(compatibilityId: string): Promise<void> {
    const budget: Budget = { compatibilityId, costRub: 0, attempts: 0 };
    const sectionStatus: Partial<Record<CompatSectionKey, 'ok' | 'regenerated' | 'failed'>> = {};
    const validation: ValidationEntry[] = [];
    const normalization: Record<string, { normalized: string[]; warnings: string[] }> = {};

    try {
      const report = await this.repo.byId(compatibilityId);
      if (report === null) {
        return;
      }

      const owner = await this.repo.chartForUser(report.chart_id, report.user_id);
      if (owner === null) {
        // Карту удалили, пока заказ стоял в очереди: это не провал текста,
        // и в брейкер такая строка попадать не должна.
        throw new CompatFailure('chart_missing');
      }

      const partner = report.compat_partner_id === null
        ? null
        : await this.repo.partner(report.compat_partner_id);
      if (partner === null) {
        throw new CompatFailure('chart_missing');
      }

      await this.repo.start(compatibilityId);

      // Партнёрская карта считается здесь и не сохраняется: она нужна один
      // раз, а её вход — ПДн, которым незачем лежать в `charts`.
      const partnerChart = await this.partnerChart(partner);
      const facts = await this.facts(owner.data as AstroChartData, partnerChart);
      await this.repo.saveFacts(compatibilityId, facts);

      const factors = factorsOf(facts);
      const distribution = distributeSections(factors);

      // Сколько фактов реально дошло до текста и какие семейства остались за
      // бортом: без этого «матрица полная» проверялась бы на глаз.
      const coverage = coverageOf(factors, distribution);

      this.logger.info('compat_focus_distribution', {
        compatibility_id: compatibilityId,
        factors: coverage.factors,
        reached: coverage.reached,
        families: coverage.familiesReached,
        families_missing: coverage.familiesMissing,
        skipped: distribution.skipped.length,
        per_section: distribution.counts,
        max_sections_per_factor: MAX_SECTIONS_PER_FACTOR,
        starved: distribution.starved,
        unmapped: distribution.unmapped,
      });

      const sections: CompatSection[] = [];
      const written: string[] = [];

      for (const key of COMPAT_SECTIONS) {
        const focus = distribution.bySection[key];
        const focusBlock =
          focus.length === 0
            ? 'Фактов для этого раздела нет: пиши на общих фактах пары, но не выдумывай новых.'
            : focus.map((factor, index) => factorLine(factor, index)).join('\n');

        const section = await this.section(key, {
          compatibilityId,
          facts: factsBlock(facts),
          focusBlock,
          previous: written,
          budget,
          validation,
          normalization,
        });

        if (!section.ok) {
          sectionStatus[key] = 'failed';
          // Отказ по коду, а не по разделу: `reason` уже в логе
          // `compat_section_dropped`, здесь важно, что именно не дали.
          throw new CompatFailure(section.code);
        }

        sectionStatus[key] = section.regenerated ? 'regenerated' : 'ok';
        // `section.body` — уже финальная строка (`finalizeSection`), её длина
        // и есть тот `chars`, что в логах. Отдельного «сохраню чуть иначе» нет.
        sections.push({
          key,
          title: COMPAT_SECTION_TITLES[key],
          text: section.body,
          order: sections.length,
        });
        written.push(section.body);
      }

      await this.db.withTransaction(async (client) => {
        await this.repo.saveProgress({
          id: compatibilityId,
          status: 'ready',
          sections,
          validation,
          sectionStatus,
          normalization,
        });
        // Списание — только сейчас, вместе со статусом `ready`. Провал выше
        // до этой строки не доходит, и кредит остаётся неизрасходованным.
        if (report.credit_entitlement_id !== null) {
          await this.repo.consumePurchase(client, report.credit_entitlement_id, compatibilityId);
        }
      });

      this.logger.info('compat_ready', {
        compatibility_id: compatibilityId,
        attempts: budget.attempts,
        cost_rub: budget.costRub,
        sections: sections.length,
        chars: sections.map((section) => section.text.length),
        prompt_version: COMPAT_PROMPT_VERSION,
      });
    } catch (error) {
      const code: CompatFailureCode =
        error instanceof CompatFailure
          ? error.code
          : error instanceof LlmError
            ? error.code
            : 'provider';

      this.logger.error('compat_failed', {
        compatibility_id: compatibilityId,
        code,
        // Причина дублируется в `reason`: по этому ключу её ищут поддержка и
        // дежурный, а `code` остаётся прежним именем поля (коды не переименовываем).
        reason: code,
        attempts: budget.attempts,
        cost_rub: budget.costRub,
        error: error instanceof Error ? error.message : String(error),
      });

      await this.repo.fail(compatibilityId, code, {
        validation,
        sectionStatus,
        normalization,
      });
    }
  }

  private async section(
    key: CompatSectionKey,
    context: {
      readonly compatibilityId: string;
      readonly facts: string;
      readonly focusBlock: string;
      readonly previous: readonly string[];
      readonly budget: Budget;
      readonly validation: ValidationEntry[];
      readonly normalization: Record<string, { normalized: string[]; warnings: string[] }>;
    },
  ): Promise<SectionWrite> {
    const range = COMPAT_RANGES.find((section) => section.key === key);
    const min = range?.min ?? 0;
    const max = range?.max ?? Number.MAX_SAFE_INTEGER;

    let lastCode: FailureCode = 'format';
    let lastChars = 0;
    let lastReason: 'empty_response' | 'unparsed' | 'unsafe' = 'empty_response';

    /**
     * Попыток на «коротко» — две: второй короткий текст отдаём как есть.
     * Не больше общего лимита: если `MAX_ATTEMPTS` когда-нибудь станет 1,
     * раздел не должен молча пропадать из-за `attempt >= 2`.
     */
    const SHORT_ATTEMPTS = Math.max(1, Math.min(2, MAX_ATTEMPTS));

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const prompt = compatSectionPrompt({
        key,
        facts: context.facts,
        focusBlock: context.focusBlock,
        previousSummary: this.summaryOf(context.previous),
      });

      // Вторая попытка получает тот же промпт: перегенерация после отказа
      // раньше давала другой текст, и сравнить две попытки было нельзя.
      const messages: LlmMessage[] = [
        { role: 'system', content: COMPAT_SYSTEM_PROMPT },
        { role: 'user', content: prompt },
      ];

      const response = await this.call(context.budget, messages);

      // --- Одна строка на всё: нормализация → обрезка → проверка → БД → лог.
      //
      // В живом прогоне `46d8b893` лог показал `trimmed to=474`, а следом
      // `chars=553`: обрезали один текст, проверяли другой (с подписью),
      // писали в БД третий. Теперь текст фиксируется `finalizeSection` один
      // раз, и `chars` — это его длина до последнего символа.
      const normalized = normalizeCompatSection({ key, bodyMd: response.content });
      const applied = [...normalized.applied];

      let final = finalizeSection({ key, bodyMd: normalized.body });
      const beforeTrim = final;
      let checked = validateCompatSection({ key, bodyMd: final.text, previous: context.previous });

      let trimmed: { readonly from: number; readonly to: number; readonly boundary: string } | null =
        null;
      const trimmedWarnings: CompatWarning[] = [];

      // --- «Слишком длинно» чинится обрезкой, а не отказом (итерация 27).
      //
      // Для `steps` это только поштучная обрезка: каждый пункт отдельно,
      // подпись прикрепляется заново (итерация 28). Общий триммер к списку
      // не применяется никогда — он режет список поперёк и теряет пункт.
      if (checked.length.verdict === 'too_long') {
        const cut = trimCompatSection({ key, bodyMd: final.text, range: { min, max } });

        if (cut === null) {
          // Резать некуда (например, `steps` пришёл без единого пункта) —
          // раздел всё равно не выбрасываем из-за длины.
          this.logger.warn('compat_section_trim_failed', {
            compatibility_id: context.compatibilityId,
            section: key,
            chars: final.chars,
            volume_chars: checked.length.chars,
            min,
            max,
          });
        } else {
          trimmed = { from: cut.from, to: cut.to, boundary: cut.boundary };
          final = finalizeSection({ key, bodyMd: cut.body });
          applied.push('trimmed');
          if (!cut.inRange) {
            // Для `steps` длина — мягкий ориентир: три действия важнее объёма.
            // Для остальных разделов сюда не попадаем (`candidate` требует
            // попадания в границы), но ветка общая и честная.
            this.logger.warn('compat_section_trim_out_of_range', {
              compatibility_id: context.compatibilityId,
              section: key,
              chars: final.chars,
              volume_chars: final.volumeChars,
              min,
              max,
            });
          }
          trimmedWarnings.push({
            code: 'trimmed',
            detail: `${cut.from} → ${cut.to} (${cut.boundary})`,
          });
          this.logger.info('compat_section_trimmed', {
            compatibility_id: context.compatibilityId,
            section: key,
            from: cut.from,
            to: cut.to,
            boundary: cut.boundary,
            chars: final.chars,
            volume_chars: final.volumeChars,
            items: key === 'steps' ? countStepsItems(final.text) : undefined,
            in_range: cut.inRange,
            min,
            max,
          });
          checked = validateCompatSection({ key, bodyMd: final.text, previous: context.previous });
        }
      }

      lastChars = final.chars;
      const volumeChars = checked.length.chars;
      const empty = final.text === '';

      // Структурные правила, которые могла сломать сама обрезка (абзацев
      // стало меньше, предложений в последнем — одно), не роняют раздел.
      const hardFailures = trimmed === null
        ? checked.failures
        : checked.failures.filter(
            (failure) => failure.rule !== 'paragraphs' && failure.rule !== 'sentences',
          );

      const shortOnly =
        hardFailures.length > 0 && hardFailures.every((failure) => failure.rule === 'too_short');
      const shortAcceptable =
        shortOnly && attempt >= SHORT_ATTEMPTS && lastChars >= COMPAT_ACCEPT_MIN_CHARS;

      if (!empty && (hardFailures.length === 0 || shortAcceptable)) {
        const warnings: CompatWarning[] = [...checked.warnings, ...trimmedWarnings];

        if (shortAcceptable) {
          this.logger.warn('compat_section_short_accepted', {
            compatibility_id: context.compatibilityId,
            section: key,
            attempt,
            chars: lastChars,
            volume_chars: volumeChars,
            min,
            max,
          });
        }

        const codes = warnings.map((warning) => warning.code);
        if (applied.length > 0 || warnings.length > 0) {
          context.normalization[key] = { normalized: applied, warnings: codes };
        }

        this.logger.info('compat_section_ok', {
          compatibility_id: context.compatibilityId,
          section: key,
          attempt,
          // `chars` — длина строки, которая уходит в БД и человеку;
          // `volume_chars` — без подписи, по ней вердикт длины.
          chars: lastChars,
          volume_chars: volumeChars,
          min,
          max,
          verdict: checked.length.verdict,
          trimmed,
          normalized: applied,
          warnings: codes,
          warnings_matched: matchedOf(warnings),
          matched: matchedOfChecks(checked.checks),
          checks: verdictsOf(checked.checks),
          was_chars: beforeTrim.chars,
        });

        return {
          ok: true,
          body: final.text,
          chars: final.chars,
          regenerated: attempt > 1,
          normalized: applied,
          warnings,
        };
      }

      // Пустой ответ — это не «слишком коротко»: коды значат разное, и по
      // `too_short` владелец ищет проблему с длиной, а не с провайдером.
      const firstRule = empty ? 'empty' : (hardFailures[0]?.rule ?? 'format');
      lastCode = this.codeOf(firstRule);
      lastReason = empty
        ? 'empty_response'
        : hardFailures.some((failure) => failure.rule === 'steps_unparsed')
          ? 'unparsed'
          : 'unsafe';
      const codes = checked.warnings.map((warning) => warning.code);

      context.validation.push({
        key,
        attempt,
        code: lastCode,
        severity: 'error',
        failures:
          hardFailures.length > 0
            ? hardFailures.map((failure) => `${failure.rule}: ${failure.detail}`)
            : ['empty: модель вернула пустой текст'],
        chars: lastChars,
        volume_chars: volumeChars,
        min,
        max,
        verdict: checked.length.verdict,
        warnings: codes,
        warnings_matched: matchedOf(checked.warnings),
        checks: checked.checks,
        ...(trimmed === null ? {} : { trimmed }),
        // Сырой ответ — 2 000 знаков: в промпте только факты пары, ПДн нет.
        raw_excerpt: response.content.trim().slice(0, RAW_EXCERPT_LENGTH),
      });

      this.logger.warn('compat_section_rejected', {
        compatibility_id: context.compatibilityId,
        section: key,
        attempt,
        code: lastCode,
        reason: lastReason,
        chars: lastChars,
        volume_chars: volumeChars,
        min,
        max,
        verdict: checked.length.verdict,
        failures: hardFailures.map((failure) => failure.rule),
        warnings: codes,
        warnings_matched: matchedOf(checked.warnings),
        matched: matchedOfChecks(checked.checks),
        checks: verdictsOf(checked.checks),
        trimmed,
      });

      // «Слишком коротко» — единственная причина, по которой повторяем вызов
      // ровно один раз. Всё остальное живёт по общему лимиту `MAX_ATTEMPTS`.
      if (shortOnly && attempt >= SHORT_ATTEMPTS) {
        break;
      }
    }

    this.logger.warn('compat_section_dropped', {
      compatibility_id: context.compatibilityId,
      section: key,
      code: lastCode,
      reason: lastReason,
      chars: lastChars,
      min,
      max,
    });

    return { ok: false, code: lastCode, reason: lastReason };
  }

  /** Правило валидатора → код `failure-codes.ts` (контракт не расширяем). */
  private codeOf(rule: string): FailureCode {
    switch (rule) {
      case 'paragraphs':
      case 'sentences':
      case 'paragraphs_split':
        return 'paragraphs';
      // «Слишком коротко» и «слишком длинно» — разные коды, и это не
      // косметика: по коду решают, повторять вызов или обрезать. В живом
      // прогоне 1 423 знака при максимуме 800 получили `too_short`.
      case 'too_short':
        return 'too_short';
      case 'too_long':
      case 'length':
        return 'too_long';
      case 'empty':
        return 'format';
      case 'format_h1':
      case 'format_table':
      case 'format_link':
      case 'format_html':
      case 'format_list':
      case 'steps_count':
      case 'steps_only_list':
      case 'ui_reference':
        return 'format';
      case 'repeats':
        return 'repeats';
      default:
        return 'format';
    }
  }

  /** Короткая сводка написанного — чтобы модель не начинала раздел так же. */
  private summaryOf(previous: readonly string[]): string {
    if (previous.length === 0) {
      return 'Раздел первый.';
    }
    return previous
      .map((body, index) => {
        const first = body.split(/(?<=[.!?])\s+/u)[0] ?? '';
        return `${index + 1}. ${first.slice(0, 180)}`;
      })
      .join('\n');
  }

  private async facts(owner: AstroChartData, partner: AstroChartData): Promise<CompatibilityFacts> {
    if (!this.astro.isConfigured) {
      throw new CompatFailure('engine');
    }
    const raw = await this.astro.synastry(owner, partner);
    try {
      return parseCompatibilityFacts(raw);
    } catch {
      throw new CompatFailure('engine');
    }
  }

  /** Карта партнёра: вход — ПДн, выход — только числа движка. */
  private async partnerChart(partner: {
    readonly birthDate: string;
    readonly birthTime: string | null;
    readonly lat: number;
    readonly lon: number;
    readonly tz: string;
  }): Promise<AstroChartData> {
    const place = this.placeOf(partner);
    return this.astro.createChart({
      birth_date: partner.birthDate,
      birth_time: partner.birthTime,
      time_precision: partner.birthTime === null ? 'unknown' : 'exact',
      birth_place: place,
    });
  }

  /**
   * Место партнёра для движка. Название берём из справочника по координатам:
   * человек его не вводил, а движку оно нужно только для подписи.
   */
  private placeOf(partner: { readonly lat: number; readonly lon: number; readonly tz: string }): GeoPlace {
    const nearest = findNearestCity(partner.lat, partner.lon, 150);
    return {
      name: nearest?.record.name ?? 'Неизвестное место',
      country: nearest?.record.country ?? 'ZZ',
      region: nearest?.record.region ?? null,
      lat: partner.lat,
      lon: partner.lon,
      tz: partner.tz,
    };
  }

  private partnerInput(input: ReturnType<typeof parseCompatRequest>) {
    return {
      relationship: input.relationship,
      birthDate: input.partner.birth_date,
      birthTime: input.partner.birth_time ?? null,
      cityId: input.partner.place.city_id ?? null,
      lat: input.partner.place.lat,
      lon: input.partner.place.lon,
      tz: input.partner.place.tz,
    };
  }

  private statusOf(row: CompatReportRow): CompatStatus {
    if (row.status === 'ready') {
      return 'ready';
    }
    if (row.status === 'failed' || row.status === 'refunded') {
      return 'failed';
    }
    return 'pending';
  }

  private titlesOf(row: CompatReportRow): string[] {
    return (row.sections ?? []).map((section) => section.title);
  }

  private view(row: CompatReportRow): CompatibilityView {
    const status = this.statusOf(row);
    const sections: CompatSectionView[] =
      status === 'ready'
        ? (row.sections ?? []).map((section, index) => ({
            key: section.key,
            title: section.title,
            order: section.order ?? index,
            text: section.text,
          }))
        : [];

    // В контракт уходят только закрытые коды: служебный словарь и род
    // партнёра остаются в БД и в логах.
    const warnings: CompatWarningView[] =
      status === 'ready'
        ? Object.entries(
            (row.normalization ?? {}) as Record<string, { warnings?: readonly string[] }>,
          ).flatMap(([section, diagnostics]) =>
            (diagnostics.warnings ?? [])
              .filter((code) => (COMPAT_CONTRACT_WARNINGS as readonly string[]).includes(code))
              .map((code) => ({ section, code })),
          )
        : [];

    const view: CompatibilityView = {
      id: row.id,
      status,
      sections,
      warnings,
      created_at: row.created_at.toISOString(),
      ...(status === 'failed' && row.error_code !== null ? { error_code: row.error_code } : {}),
    };

    return view;
  }

  /** Один вызов провайдера: лимиты проверяются до следующего вызова. */
  private async call(budget: Budget, messages: readonly LlmMessage[]): Promise<LlmResponse> {
    const capRub = this.env.LLM_COMPAT_CAP_RUB;
    if (budget.costRub >= capRub) {
      throw new CompatFailure('cost_cap');
    }

    const monthCost = await this.repo.monthCostRub();
    if (monthCost >= this.env.LLM_MONTHLY_CAP_RUB_REPORT) {
      throw new CompatFailure('monthly_cap');
    }

    const response = await this.llm.complete({ messages });
    budget.costRub = Math.round((budget.costRub + response.usage.costRub) * 10_000) / 10_000;
    budget.attempts += 1;
    await this.repo.addCost(
      budget.compatibilityId,
      {
        costRub: response.usage.costRub,
        promptTokens: response.usage.promptTokens,
        completionTokens: response.usage.completionTokens,
      },
      1,
    );

    if (budget.costRub > capRub) {
      throw new CompatFailure('cost_cap');
    }

    return response;
  }
}
