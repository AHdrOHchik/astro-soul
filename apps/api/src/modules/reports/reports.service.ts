import { Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { Chart } from '@astro-soul/shared';
import { ApiError, notFound } from '../../common/api-error';
import { JsonLogger } from '../../common/logger';
import { APP_ENV } from '../../config/env.module';
import type { AppEnv } from '../../config/env';
import type { VerifiedInitData } from '../auth/init-data';
import { AccessService } from '../entitlements/access.service';
import { EntitlementsService } from '../entitlements/entitlements.service';
import { LLM_PROVIDER } from '../llm/llm.module';
import { LlmError, type LlmMessage, type LlmProvider, type LlmResponse } from '../llm/llm.client';
import { FileStorageService } from '../files/file-storage.service';
import { UsersRepository } from '../users/users.repository';
import { CHART_FACTS_VERSION, serializeTopFactors } from './top-factors';
import { fewShotBlocks } from './corpus';
import { buildDigest } from './digests';
import { breakerState, BREAKER_THRESHOLD, type BreakerState } from './breaker';
import {
  classifyFailures,
  failureCodeOf,
  isRetryable,
  type FailureCode,
} from './failure-codes';
import {
  normalizeSection,
  normalizeTeaser,
  type NormalizationCode,
  type TeaserNormalization,
} from './normalize';
import {
  CONTENT_SECTIONS,
  distributeFocuses,
  focusBlockFor,
  type FocusDistribution,
} from './focus-map';
import {
  chapterPrompt,
  planPrompt,
  PROMPT_VERSION,
  retryNote,
  SECTION_RULES,
  summaryPrompt,
  SYSTEM_PROMPT,
  TIME_PRECISION_NOTE,
} from './prompts';
import { parseIdempotencyKey, parseReportRequest, type ReportType } from './reports.dto';
import {
  ReportsRepository,
  type ReportChapter,
  type ReportRow,
} from './reports.repository';
import {
  DISCLAIMER,
  SECTIONS,
  STRUCTURE_VERSION,
  TEASER_LENGTH,
  validateSection,
  type SectionKey,
  type TimePrecision,
} from './validators';

const ALL_SECTIONS: readonly SectionKey[] = [...CONTENT_SECTIONS, 'summary'];

/**
 * Итог одной главы (итерация 18).
 *
 * `ok: false` — главу не удалось собрать и показывать её нечего (пустой ответ,
 * недобор материала, запрещённая тема). Такая глава попадает в
 * `missing_sections`, но разбор из-за неё не пропадает: пока живы три главы
 * и «Итог», человек получает то, что собралось.
 */
type SectionWrite =
  | {
      readonly ok: true;
      readonly body: string;
      readonly regenerated: boolean;
      readonly normalized: readonly NormalizationCode[];
      readonly warnings: readonly FailureCode[];
      /** Окно тизера — считается здесь же, чтобы попасть в `validation`. */
      readonly teaser?: TeaserNormalization;
    }
  | { readonly ok: false; readonly code: FailureCode };

/** Что нормализатор сделал с главой — в `reports.normalization`. */
interface SectionDiagnostics {
  readonly normalized: readonly string[];
  readonly warnings: readonly string[];
  /** Числа для разбора: смещение окна тизера и первого термина в нём. */
  readonly detail?: readonly string[];
}

/**
 * Хвост частичного разбора — последний абзац «Итога» (текст владельца).
 * Человек должен понимать, что видит не весь разбор, и что пересборка
 * бесплатна; иначе частичный разбор выглядит как «нам не хватило глав».
 */
export const MISSING_SECTIONS_NOTE =
  'Часть глав не удалось собрать. Попробуй пересобрать разбор — это бесплатно, или напиши в поддержку.';

/** Минимум живых глав, при котором разбор ещё показывается. */
const MIN_LIVE_CHAPTERS = 3;

/** Первые 400 знаков `core` — то, что видно до оплаты (контракт). */
export { TEASER_LENGTH };

/**
 * Коды пометок, которые контракт 1.5.11 разрешает в `Report.warnings`.
 * БД хранит больше (служебный словарь, повторы зачинов, недобор «Итога»),
 * но расширять enum без новой версии контракта нельзя.
 */
const CONTRACT_WARNING_CODES = [
  'paragraphs',
  'too_long',
  'repeats',
  'format',
  'paragraphs_split',
  'paragraphs_merged',
  'trimmed',
  'teaser_terms',
  'disclaimer_added',
] as const;

export interface ReportWarningView {
  readonly section: string;
  readonly code: string;
}

export interface ReportSectionView {
  readonly key: string;
  readonly title: string;
  readonly body_md: string;
  readonly order: number;
}

/** Тело ответа `Report` (контракт 1.5.1). */
export interface ReportView {
  readonly report_id: string;
  readonly chart_id: string;
  readonly type: ReportType;
  readonly status: 'queued' | 'generating' | 'ready' | 'failed' | 'refunded';
  readonly progress: number;
  readonly created_at: string;
  readonly ready_at: string | null;
  /**
   * Подписанная ссылка на собранный PDF (1.6.8) или `null`, если файла ещё
   * нет. Ссылка живёт 24 часа и обновляется на каждом `GET /reports/{id}`;
   * прямых адресов хранилища не бывает.
   */
  readonly pdf_url: string | null;
  readonly sections: readonly ReportSectionView[];
  readonly is_paid: boolean;
  readonly teaser?: string;
  /**
   * Главы, которых нет в разборе (контракт 1.5.11). Пусто у полного разбора;
   * непусто, когда часть глав не прошла и разбор отдан частичным.
   */
  readonly missing_sections: readonly string[];
  /** Главы с пометками формы: `{section, code}` (контракт 1.5.11). */
  readonly warnings: readonly ReportWarningView[];
}

/**
 * Попыток на главу — две: одна генерация и одна перегенерация. Живой прогон
 * 16.11.2026 записал `attempts: 5` и 4,1 ₽ за неудачу; лимит закреплён
 * константой, а не числом в цикле.
 */
export const MAX_ATTEMPTS = 2;

/** Первые 2000 знаков сырого ответа модели при провале — в лог и в `reports.validation`. */
export const RAW_EXCERPT_LENGTH = 2_000;

/**
 * Одна неудачная попытка главы в `reports.validation`.
 *
 * `raw_excerpt` — первые 2000 знаков ответа модели: без них диагностика
 * превращается в гадание (пять попыток прогона 16.11.2026 восстановить было
 * нечем). ПДн здесь нет: в промпт уходят только `chart_facts`.
 */
interface ValidationEntry {
  readonly key: string;
  readonly attempt: number;
  readonly code: string;
  /**
   * `error` — главу не показать; `warning` — показали, но нарушение есть.
   * До итерации 19 в `validation` попадали только провалы, поэтому по живому
   * прогону нельзя было понять, что «глава прошла с тремя пометками».
   */
  readonly severity: 'error' | 'warning';
  readonly failures: readonly string[];
  readonly chars: number;
  /** Сырой ответ модели — только для `error`: 2000 знаков (ПДн в нём нет). */
  readonly raw_excerpt?: string;
}

/** Провал конвейера: код уходит в `reports.error_code`. */
type ReportFailureCode = 'cost_cap' | 'monthly_cap' | 'provider' | 'chart_missing' | FailureCode;

class ReportFailure extends Error {
  constructor(readonly code: ReportFailureCode) {
    super(code);
    this.name = 'ReportFailure';
  }
}

interface Budget {
  readonly reportId: string;
  costRub: number;
  attempts: number;
}

function contractStatus(status: string): ReportView['status'] {
  if (status === 'planning' || status === 'writing') {
    return 'generating';
  }
  if (status === 'queued' || status === 'ready' || status === 'failed' || status === 'refunded') {
    return status;
  }
  return 'queued';
}

function titleOf(key: string): string {
  return SECTIONS.find((section) => section.key === key)?.title ?? key;
}

function stripJsonFence(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/u.exec(trimmed);
  return fenced?.[1] ?? trimmed;
}

interface PlanJson {
  readonly thesis: string;
  readonly focuses: readonly { readonly topic?: string; readonly factor?: string; readonly angle?: string }[];
  readonly avoid?: readonly string[];
}

/**
 * Конвейер разбора: план → шесть глав → сводки → «Итог».
 *
 * Три правила, ради которых он написан именно так:
 *   1. В промпт попадают только `chart_facts` — whitelist из `chart-facts.ts`.
 *      Ни даты, ни места, ни имени: ПДн в LLM не уходят.
 *   2. Каждая глава проверяется валидаторами, и на перегенерацию даётся ровно
 *      одна попытка. Две неудачи — разбор `failed`, деньги возвращает джоб.
 *   3. Стоимость считается по `usage` каждого вызова и проверяется **до**
 *      следующего: перерасход останавливает разбор, а не «дописывает как-то».
 */
@Injectable()
export class ReportsService {
  constructor(
    @Inject(ReportsRepository) private readonly repo: ReportsRepository,
    @Inject(EntitlementsService) private readonly entitlements: EntitlementsService,
    @Inject(AccessService) private readonly access: AccessService,
    @Inject(UsersRepository) private readonly users: UsersRepository,
    @Inject(FileStorageService) private readonly storage: FileStorageService,
    @Inject(LLM_PROVIDER) private readonly llm: LlmProvider,
    @Inject(APP_ENV) private readonly env: AppEnv,
    @Inject(JsonLogger) private readonly logger: JsonLogger,
  ) {}

  async order(
    auth: VerifiedInitData,
    idempotencyHeader: string | undefined,
    body: unknown,
  ): Promise<ReportView> {
    const idempotencyKey = parseIdempotencyKey(idempotencyHeader);
    const input = parseReportRequest(body);
    const userId = this.users.userIdFor(auth.telegramUserId);

    const chart = await this.repo.chartForUser(input.chart_id, userId);
    if (chart === null) {
      throw notFound({ message: 'Такой карты нет. Построй карту заново', reason: 'chart_not_found' });
    }

    const entitlement = await this.entitlements.getEntitlements(userId);

    // Б-4: повтор с тем же `Idempotency-Key` обязан вернуть тот же объект, что
    // `GET /reports/{id}`. Раньше здесь жёстко стояло `is_paid: false`, и
    // оплаченный разбор в ответе выглядел неоплаченным.
    const byKey = await this.repo.findByIdempotencyKey(userId, idempotencyKey);
    if (byKey !== null) {
      return this.view(byKey, entitlement.fullReport);
    }

    const latest = await this.repo.latestForChart(chart.id, 'report');

    // Пока разбор собирается (или уже собран), второй заказ бессмысленен:
    // отдаём существующий, деньги не списываем.
    if (latest !== null && latest.status !== 'failed' && latest.status !== 'refunded') {
      return this.view(latest, entitlement.fullReport);
    }

    // Проверка доступа — через единственную дверь `hasAccess` (1.6.14).
    //   • оплаченный разбор этой карты — как раньше, по карте, а не по флагу
    //     `fullReport`: одна покупка не открывает разборы по другим картам;
    //   • одноразовое право (`single_report` из кода партнёра или «первых 50»)
    //     списывается здесь же — атомарно, в одной транзакции. Поэтому двойной
    //     тап не даёт двух бесплатных разборов, а отказ в правах не оставляет
    //     «сгоревшее» право.
    const owned = await this.access.hasAccess(userId, 'report', {
      chartId: chart.id,
      consume: true,
    });
    if (!owned) {
      throw new ApiError('PAYMENT_REQUIRED', 402, {
        message: 'Полный разбор — отдельная покупка. Оформи её на экране разбора',
        reason: 'report_not_paid',
      });
    }

    // Circuit breaker (итерация 17): три провала валидации подряд — новые
    // разборы не запускаются. Проверка стоит до `create`, чтобы не завести
    // разбор, который заведомо упадёт и сожжёт ещё 0,85 ₽.
    //
    // Итерация 18: блокировку можно выключить переменной окружения
    // `REPORT_BREAKER_ENABLED=0` — только отказ в запуске, всё остальное
    // (лимит попыток, валидаторы, капы, окно 30 минут) остаётся.
    const breaker = await this.breaker();
    if (this.env.REPORT_BREAKER_ENABLED === '1' && breaker.open) {
      this.logger.warn('report_breaker_open', {
        streak: breaker.streak,
        threshold: BREAKER_THRESHOLD,
        retry_after_ms: breaker.retry_after_ms,
      });
      throw new ApiError('UPSTREAM_LLM', 503, {
        message: 'Разборы временно не собираются — мы уже разбираемся. Попробуй позже',
        reason: 'report_breaker_open',
        // `reason` в теле ошибки живёт в `details` (контракт 1.5.10).
        details: { reason: 'report_breaker_open', retry_after_ms: breaker.retry_after_ms },
      });
    }

    const facts = this.factsFor(chart.data.chart);
    const report = await this.repo.create({
      chartId: chart.id,
      userId,
      kind: 'report',
      idempotencyKey,
      chartHash: createHash('sha256').update(facts).digest('hex'),
      model: this.llm.name,
      promptVersion: PROMPT_VERSION,
      structureVersion: STRUCTURE_VERSION,
      chartFactsVersion: CHART_FACTS_VERSION,
    });

    this.logger.info('report_queued', {
      report_id: report.id,
      model: this.llm.name,
      chart_facts_version: CHART_FACTS_VERSION,
      chart_hash: createHash('sha256').update(facts).digest('hex').slice(0, 12),
    });

    // Асинхронно, как в проде: ответ 202 не ждёт модели.
    void this.run(report.id).catch((error: unknown) => {
      // `run` сам помечает разбор `failed`; здесь только страховка от тишины.
      this.logger.error('report_runner_crashed', {
        report_id: report.id,
        error: error instanceof Error ? error.message : String(error),
      });
    });

    // `owned` — не «оплачено», а «текст доступен»: после расхода
    // одноразового права строка `entitlements` уже создана выше, но блок прав
    // прочитан раньше неё. Отдавать `is_paid: false` на только что выданный
    // бесплатный разбор значило бы соврать клиенту.
    return this.view(report, owned);
  }

  async get(auth: VerifiedInitData, reportId: string): Promise<ReportView> {
    const userId = this.users.userIdFor(auth.telegramUserId);
    const report = await this.repo.owned(reportId, userId);

    if (report === null) {
      throw notFound({ message: 'Такого разбора нет. Обнови приложение', reason: 'report_not_found' });
    }

    const entitlement = await this.entitlements.getEntitlements(userId);

    // `pdf_url` — свежая подписанная ссылка на уже собранный документ.
    // `null` означает «PDF ещё не собирали», а не «недоступно»: заказывают его
    // через `POST /reports/{id}/pdf`, и это отдельное действие.
    const paid = entitlement.fullReport;
    const key =
      paid && report.status === 'ready'
        ? await this.repo.readyPdfKey(report.id, this.env.ENGINE_VERSION, PROMPT_VERSION)
        : null;

    return this.view(report, paid, key);
  }

  /**
   * Блок фактов для промпта: `chart_facts` v1.2 — отобранные 7–9 позиций
   * вместо полной карты (задача C, `top-factors.ts`).
   *
   * Полная карта (`serializeChartFacts` v1.1 + дополнения) больше не уходит в
   * модель: вход был главной статьёй расхода. Версия пишется в
   * `reports.chart_facts_version`, чтобы «дешёвый разбор» отличался от
   * «сломанного отбора».
   */
  private factsFor(chart: Chart): string {
    return serializeTopFactors(chart);
  }

  private view(report: ReportRow, paid: boolean, pdfKey: string | null = null): ReportView {
    const status = contractStatus(report.status);
    const chapters = report.chapters ?? [];
    const progress =
      status === 'ready'
        ? 100
        : status === 'queued'
          ? 0
          : Math.min(95, 5 + Math.round((chapters.length / ALL_SECTIONS.length) * 90));

    const sections: ReportSectionView[] = paid
      ? chapters.map((chapter, index) => ({
          key: chapter.key,
          title: chapter.title,
          body_md: chapter.body_md,
          order: chapter.order ?? index,
        }))
      : [];

    // Частичный разбор: какие главы не собрались. Только для `ready` —
    // у собирающегося разбора «не хватает» всех глав, и это не новость.
    const present = new Set(chapters.map((chapter) => chapter.key));
    const missing_sections: string[] =
      status === 'ready' ? ALL_SECTIONS.filter((key) => !present.has(key)) : [];

    // Пометки по главам: что нормализатор поправил (`normalized`) и какие
    // нарушения формы остались (`warnings`). Фронт не обязан их показывать,
    // но без них частичный разбор не отличить от «модель так и задумала».
    const warnings: ReportWarningView[] =
      status === 'ready'
        ? Object.entries(report.normalization ?? {}).flatMap(([section, diagnostics]) =>
            (diagnostics?.warnings ?? [])
              // Контракт не меняется: в API уходят только коды из enum
              // `Report.warnings` (1.5.11). Остальные (`service_terms`,
              // `repeated_opener`, `too_short`) остаются в БД и в логах.
              .filter((code) => (CONTRACT_WARNING_CODES as readonly string[]).includes(code))
              .map((code) => ({ section, code })),
          )
        : [];

    const view: ReportView = {
      report_id: report.id,
      chart_id: report.chart_id,
      type: report.kind === 'report' ? 'full' : (report.kind as ReportType),
      status,
      progress,
      created_at: report.created_at.toISOString(),
      ready_at: status === 'ready' ? report.updated_at.toISOString() : null,
      pdf_url: pdfKey === null ? null : this.storage.signedUrl(pdfKey).url,
      sections,
      is_paid: paid,
      ...(report.teaser === null ? {} : { teaser: report.teaser }),
      missing_sections,
      warnings,
    };

    return view;
  }

  /**
   * Перезапуск разбора, который админка уже вернула в очередь (1.6.16).
   *
   * Метод существует потому, что `run` — приватный, и открывать его целиком
   * наружу значило бы разрешить запуск любого разбора в обход очереди и
   * проверок. Здесь ровно одно действие: «сгенерировать эту строку в фоне».
   * Ответ панели (`202`) от модели не зависит, поэтому ошибка только пишется в
   * лог — как у заказа человеком.
   */
  restart(reportId: string): void {
    void this.run(reportId).catch((error: unknown) => {
      this.logger.error('report_rerun_crashed', {
        report_id: reportId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  /** Генерация: статусы `planning` → `writing` → `ready` (или `failed`). */
  private async run(reportId: string): Promise<void> {
    const budget: Budget = { reportId, costRub: 0, attempts: 0 };
    const sectionStatus: Partial<Record<SectionKey, 'ok' | 'regenerated' | 'failed'>> = {};
    const validation: ValidationEntry[] = [];
    // Что нормализация поправила: нужно и в `ready`, и в `failed`.
    const normalization: Record<string, SectionDiagnostics> = {};

    try {
      const report = await this.repo.byId(reportId);
      if (report === null) {
        return;
      }

      const chart = await this.repo.chartForUser(report.chart_id, report.user_id);
      if (chart === null) {
        // Карту удалили, пока разбор стоял в очереди: это не провал текста,
        // и в circuit breaker такая строка попадать не должна.
        throw new ReportFailure('chart_missing');
      }

      const facts = this.factsFor(chart.data.chart);
      const timePrecision = this.precisionOf(facts);

      await this.repo.start(reportId);

      const plan = await this.plan(facts, budget);
      await this.repo.savePlan(reportId, plan);

      // Фокусы плана делятся по главам детерминированно (`focus-map.ts`).
      // Раньше каждая глава получала весь план: семь тем в 3–6 абзацев не
      // укладываются, и модель сжимала их в один абзац (`talents`, 16.11.2026).
      const focuses = distributeFocuses(plan.focuses);
      const avoid = this.avoidBlock(plan);
      this.logger.info('report_focus_distribution', {
        report_id: reportId,
        focuses_in_plan: plan.focuses.length,
        per_chapter: focuses.counts,
        unmapped: focuses.unmapped,
        // Главы, которым не хватило факторов под лимит «≤ 3 главы на фактор».
        starved: focuses.starved,
      });
      if (focuses.starved.length > 0) {
        this.logger.warn('report_focus_starved', {
          report_id: reportId,
          sections: focuses.starved,
        });
      }

      const chapters: ReportChapter[] = [];
      const written: string[] = [];
      const digests: string[] = [];
      const failed: { key: SectionKey; code: FailureCode }[] = [];
      let teaser: string | null = null;

      for (const [index, key] of CONTENT_SECTIONS.entries()) {
        const write = await this.section(key, {
          reportId,
          facts,
          timePrecision,
          thesis: plan.thesis,
          focuses,
          avoid,
          previousSummary: digests.map((digest, position) => `${position + 1}. ${digest}`).join('\n'),
          previous: written,
          budget,
          validation,
        });

        // Глава не вышла. «Ядро» роняет разбор сразу: без него показывать
        // нечего, и дописывать остальные шесть глав за деньги незачем.
        // Остальные — копятся в `missing_sections`, разбор продолжается.
        if (!write.ok) {
          sectionStatus[key] = 'failed';
          failed.push({ key, code: write.code });
          this.logger.warn('report_section_missing', {
            report_id: reportId,
            section: key,
            code: write.code,
          });
          if (key === 'core') {
            throw new ReportFailure(write.code);
          }
          continue;
        }

        sectionStatus[key] = write.regenerated ? 'regenerated' : 'ok';

        // Тизер уже посчитан в `writeSection` — здесь только запоминаем окно
        // и его смещение. Окно — «первые 400 знаков» по контракту, но при
        // терминах оно сдвигается внутри `core`: пейволл показывает текст без
        // названий планет (§3.1). Смещение видно в `normalization` и в логе.
        const teaserView = write.teaser;
        if (teaserView !== undefined) {
          teaser = teaserView.teaser;
        }

        const details: string[] = [];
        if (teaserView !== undefined && teaserView.start > 0) {
          details.push(`teaser_start=${teaserView.start}`);
        }
        if (teaserView !== undefined && teaserView.firstTerm !== null) {
          details.push(`teaser_first_term=${teaserView.firstTerm}`);
        }

        if (write.normalized.length > 0 || write.warnings.length > 0 || details.length > 0) {
          normalization[key] = {
            normalized: write.normalized,
            warnings: write.warnings,
            ...(details.length === 0 ? {} : { detail: details }),
          };
        }

        const body = write.body;
        written.push(body);
        digests.push(buildDigest(body));
        chapters.push({ key, title: titleOf(key), body_md: body, order: index });

        await this.repo.saveProgress({
          id: reportId,
          status: 'writing',
          chapters,
          teaser,
          normalization,
        });
      }

      // Меньше трёх живых глав — показывать нечего: это `failed`, как и
      // раньше. Код — провал первой несобранной главы, чтобы в метриках
      // осталась причина, а не «частичный разбор».
      if (chapters.length < MIN_LIVE_CHAPTERS) {
        throw new ReportFailure(failed[0]?.code ?? 'format');
      }

      const summary = await this.summary({
        thesis: plan.thesis,
        timePrecision,
        digests,
        previous: written,
        budget,
        validation,
        missing: failed.map((entry) => entry.key),
      });

      // «Итог» — обязательная глава: без него разбор не закрывается.
      if (!summary.ok) {
        sectionStatus.summary = 'failed';
        throw new ReportFailure(summary.code);
      }

      sectionStatus.summary = summary.regenerated ? 'regenerated' : 'ok';
      if (summary.normalized.length > 0 || summary.warnings.length > 0) {
        normalization['summary'] = {
          normalized: summary.normalized,
          warnings: summary.warnings,
        };
      }

      // Хвост частичного разбора: человек видит, что глав не хватает, и что
      // пересборка бесплатна. Приписывается после валидатора — это текст
      // сервиса, а не модели, и объём «Итога» им не проверяется.
      const summaryBody =
        failed.length === 0 ? summary.body : `${summary.body}\n\n${MISSING_SECTIONS_NOTE}`;

      chapters.push({
        key: 'summary',
        title: titleOf('summary'),
        body_md: summaryBody,
        order: CONTENT_SECTIONS.length,
      });

      await this.repo.saveProgress({
        id: reportId,
        status: 'ready',
        chapters,
        teaser,
        digests,
        validation,
        sectionStatus,
        normalization,
      });

      this.logger.info('report_ready', {
        report_id: reportId,
        attempts: budget.attempts,
        cost_rub: budget.costRub,
        chapters: chapters.length,
        // Частичный разбор виден в логе без похода в БД: сколько глав не
        // собралось и какие именно.
        missing_sections: failed.map((entry) => entry.key),
        normalized: Object.values(normalization).reduce(
          (sum, diagnostics) => sum + diagnostics.normalized.length,
          0,
        ),
        warnings: Object.values(normalization).reduce(
          (sum, diagnostics) => sum + diagnostics.warnings.length,
          0,
        ),
      });
    } catch (error) {
      const code =
        error instanceof ReportFailure
          ? error.code
          : error instanceof LlmError
            ? error.code
            : 'provider';

      this.logger.error('report_failed', {
        report_id: reportId,
        code,
        attempts: budget.attempts,
        cost_rub: budget.costRub,
        error: error instanceof Error ? error.message : String(error),
      });

      await this.repo.fail(reportId, code);
      // Отметки о главах остаются в `reports.section_status`: видно, где встали.
      await this.repo.saveDiagnostics(reportId, sectionStatus, validation, normalization);
    }
  }

  private precisionOf(facts: string): TimePrecision {
    const matched = /^time_precision:\s*(\w+)$/mu.exec(facts);
    const value = matched?.[1];
    return value === 'approximate' || value === 'unknown' ? value : 'exact';
  }

  private async plan(facts: string, budget: Budget): Promise<PlanJson> {
    const response = await this.call(budget, [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: planPrompt(facts) },
    ]);

    // Провал стадии «план» — это формат ответа, а не текст главы: код
    // `format` отличается от `paragraphs`/`too_short` и в метриках, и в
    // circuit breaker. Сырой ответ сохраняем по тем же правилам, что и главы.
    let parsed: unknown;
    try {
      parsed = JSON.parse(stripJsonFence(response.content));
    } catch {
      this.logPlanFailure(budget.reportId, 'json', response.content);
      throw new ReportFailure('format');
    }

    const plan = parsed as Partial<PlanJson>;
    if (typeof plan.thesis !== 'string' || !Array.isArray(plan.focuses)) {
      this.logPlanFailure(budget.reportId, 'shape', response.content);
      throw new ReportFailure('format');
    }

    return {
      thesis: plan.thesis,
      focuses: plan.focuses,
      avoid: plan.avoid ?? [],
    };
  }

  /** Сырой ответ стадии «план» при провале: 2000 знаков, как и у глав. */
  private logPlanFailure(reportId: string, reason: 'json' | 'shape', raw: string): void {
    this.logger.warn('report_plan_invalid', {
      report_id: reportId,
      reason,
      chars: raw.trim().length,
      raw_excerpt: raw.trim().slice(0, RAW_EXCERPT_LENGTH),
    });
  }

  /** Общий запрет на повторы: он один на разбор, а не на главу. */
  private avoidBlock(plan: PlanJson): string {
    if (plan.avoid === undefined || plan.avoid.length === 0) {
      return '';
    }
    return `Не повторять: ${plan.avoid.join('; ')}`;
  }

  /** Состояние circuit breaker: серия провалов валидации по последним разборам. */
  private async breaker(): Promise<BreakerState> {
    const { streak, lastFailedAt } = await this.repo.validationStreak();
    return breakerState(streak, lastFailedAt);
  }

  private async section(
    key: Exclude<SectionKey, 'summary'>,
    context: {
      readonly reportId: string;
      readonly facts: string;
      readonly timePrecision: TimePrecision;
      readonly thesis: string;
      readonly focuses: FocusDistribution;
      /** Общий `avoid` плана — одинаковый во всех главах. */
      readonly avoid: string;
      readonly previousSummary: string;
      readonly previous: readonly string[];
      readonly budget: Budget;
      readonly validation: ValidationEntry[];
    },
  ): Promise<SectionWrite> {
    // Ровно 2–3 фокуса этой главы + общий `avoid`: остальные темы плана в
    // промпт не попадают, и упоминать их модель не обязана.
    const own = focusBlockFor(context.focuses, key);
    const prompt = chapterPrompt({
      key,
      chartFacts: context.facts,
      thesis: context.thesis,
      focusBlock: context.avoid === '' ? own : `${own}\n\n${context.avoid}`,
      previousSummary: context.previousSummary === '' ? 'пока ничего' : context.previousSummary,
      timePrecision: context.timePrecision,
      examples: fewShotBlocks(2).map((block) => block.text),
    });

    return this.writeSection(key, prompt, context);
  }

  private async summary(context: {
    readonly thesis: string;
    readonly digests: readonly string[];
    readonly timePrecision: TimePrecision;
    readonly previous: readonly string[];
    readonly budget: Budget;
    readonly validation: ValidationEntry[];
    /** Главы, которые уже не собрать: «Итог» не должен их пересказывать. */
    readonly missing: readonly SectionKey[];
  }): Promise<SectionWrite> {
    const prompt = summaryPrompt({
      thesis: context.thesis,
      digests: context.digests,
      timePrecision: context.timePrecision,
    });

    if (context.missing.length > 0) {
      this.logger.warn('report_summary_partial', {
        report_id: context.budget.reportId,
        missing_sections: context.missing,
      });
    }

    return this.writeSection('summary', prompt, {
      timePrecision: context.timePrecision,
      previous: context.previous,
      budget: context.budget,
      validation: context.validation,
    });
  }

  /**
   * Одна глава: генерация → нормализация → валидатор → (при нужде) одна
   * перегенерация.
   *
   * Правила итерации 19 (три живых прогона 18.11.2026):
   *
   *   1. **Глава не пропадает из-за пометки.** Приговор выносят только
   *      пустой ответ (< 300 знаков) и неизвестная глава — см.
   *      `severityOfRule`. `forbidden_terms`, абзацы, повторы, служебный
   *      словарь и зачины — `warning`: текст отдаётся, нарушение остаётся
   *      в `reports.validation` и в `normalization`.
   *   2. **Тизер считается здесь же.** Окно 400 знаков и смещение первого
   *      термина попадают в `validation` (правило `teaser_terms`), а не
   *      только в `normalization`: раньше следа в `validation` не было
   *      вовсе, и владелец не мог понять, сработал сдвиг или нет.
   *   3. **«Итог» с недобором не выбрасывается.** `summary_short` — это
   *      `too_short`: один ретрай с тем же промптом («Объём 500–750 знаков»),
   *      после второго недобора глава отдаётся с `warning too_short`
   *      (текст не выдумываем). Частоту видно по `report_summary_short`
   *      в логе и по `normalization.summary.warnings` в БД.
   */
  private async writeSection(
    key: SectionKey,
    prompt: string,
    context: {
      readonly timePrecision: TimePrecision;
      readonly previous: readonly string[];
      readonly budget: Budget;
      readonly validation: ValidationEntry[];
    },
  ): Promise<SectionWrite> {
    let lastCode: FailureCode = 'format';
    let lastChars = 0;
    let asked = prompt;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const response = await this.call(context.budget, [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: asked },
      ]);

      const raw = response.content.trim();
      const normalization = normalizeSection({ key, bodyMd: raw });
      const body = normalization.body;
      lastChars = body.length;

      // Тизер существует только у «Ядра»: окно 400 знаков и точка входа.
      const teaser = key === 'core' ? normalizeTeaser(body) : undefined;

      const result = validateSection({
        key,
        bodyMd: body,
        timePrecision: context.timePrecision,
        previous: context.previous,
        ...(teaser === undefined ? {} : { teaser: teaser.teaser }),
      });

      const { errors, warnings } = classifyFailures({
        key,
        bodyLength: body.length,
        failures: result.failures,
      });

      if (normalization.applied.length > 0) {
        this.logger.info('report_section_normalized', {
          report_id: context.budget.reportId,
          section: key,
          applied: normalization.applied,
          notes: normalization.notes,
          chars: { raw: raw.length, normalized: body.length },
        });
      }

      if (teaser !== undefined && teaser.shifted) {
        this.logger.info('report_teaser_shifted', {
          report_id: context.budget.reportId,
          section: key,
          start: teaser.start,
          first_term: teaser.firstTerm,
        });
      }

      // «Итог» с недобором: главу не выбрасываем — без неё разбор не
      // закрывается, а вернуть 66 знаков текста можно только генерацией,
      // которую мы уже попробовали. Отдаём с пометкой, но **только после
      // второй попытки**: первая короткая — повод попросить объём ещё раз.
      const summaryShort =
        key === 'summary' &&
        attempt >= MAX_ATTEMPTS &&
        errors.length > 0 &&
        errors.every((error) => error.code === 'too_short');

      // Недобор объёма — пометка, но не приговор: один повтор с тем же
      // промптом («Объём … знаков») иногда добирает текст. Повторяем только
      // `too_short` — косметика (`format_h1`, повторы) второго вызова не
      // стоит: это те же деньги за тот же текст.
      const shortAndRetryable =
        errors.length === 0 &&
        warnings.some((warning) => warning.code === 'too_short') &&
        attempt < MAX_ATTEMPTS;

      if ((errors.length === 0 && !shortAndRetryable) || summaryShort) {
        const warningCodes = [...new Set(warnings.map((warning) => warning.code))];
        if (summaryShort) {
          warningCodes.push('too_short');
          this.logger.warn('report_summary_short', {
            report_id: context.budget.reportId,
            chars: body.length,
            min: SECTIONS.find((section) => section.key === 'summary')?.min ?? 0,
            attempts: attempt,
          });
        }

        const normalized: NormalizationCode[] = [...normalization.applied];

        // Повторы не правятся постобработкой (это не форма, а содержание),
        // поэтому они остаются в тексте — но с пометкой, чтобы это не
        // выглядело как «валидатор пропустил».
        if (warningCodes.includes('repeats') && !normalized.includes('repeats')) {
          normalized.push('repeats');
        }

        // Каждая пометка остаётся следом в `reports.validation`: иначе по
        // готовому разбору не видно, что глава прошла «на грани».
        for (const warning of warnings) {
          context.validation.push({
            key,
            attempt,
            code: warning.code,
            severity: 'warning',
            failures: [`${warning.rule}: ${warning.detail}`],
            chars: body.length,
          });
        }

        if (warnings.length > 0) {
          this.logger.warn('report_section_warnings', {
            report_id: context.budget.reportId,
            section: key,
            attempt,
            warnings: warnings.map((warning) => `${warning.rule}: ${warning.detail}`),
            codes: warningCodes,
          });
        }

        if (attempt > 1) {
          this.logger.warn('report_section_regenerated', {
            section: key,
            attempt,
            warnings: result.warnings,
          });
        }

        return {
          ok: true,
          body,
          regenerated: attempt > 1,
          normalized,
          warnings: warningCodes,
          ...(teaser === undefined ? {} : { teaser }),
        };
      }

      if (shortAndRetryable) {
        this.logger.warn('report_section_retry_short', {
          report_id: context.budget.reportId,
          section: key,
          attempt,
          chars: body.length,
        });
        // След первой попытки тоже остаётся: иначе по `validation` не видно,
        // что глава была короче нормы дважды, а не один раз.
        for (const warning of warnings) {
          context.validation.push({
            key,
            attempt,
            code: warning.code,
            severity: 'warning',
            failures: [`${warning.rule}: ${warning.detail}`],
            chars: body.length,
          });
        }
        continue;
      }

      const code = failureCodeOf({
        key,
        bodyLength: body.length,
        failures: errors.map((error) => ({ rule: error.rule, detail: error.detail })),
      });
      lastCode = code;

      const rawExcerpt = body.slice(0, RAW_EXCERPT_LENGTH);

      // Сырой ответ модели — в лог и в `reports.validation`: без него причину
      // провала приходится восстанавливать по догадкам.
      this.logger.warn('report_section_validation_failed', {
        report_id: context.budget.reportId,
        section: key,
        attempt,
        code,
        severity: 'error',
        chars: body.length,
        failures: errors.map((error) => `${error.rule}: ${error.detail}`),
        raw_excerpt: rawExcerpt,
      });

      context.validation.push({
        key,
        attempt,
        code,
        severity: 'error',
        failures: errors.map((error) => `${error.rule}: ${error.detail}`),
        chars: body.length,
        raw_excerpt: rawExcerpt,
      });

      const retryable = errors.some((error) => isRetryable(error.code));
      if (!retryable || attempt === MAX_ATTEMPTS) {
        return { ok: false, code };
      }

      // Повтор просит объём прямым текстом: в общем промпте цифра тонет,
      // а на живом прогоне 18.11.2026 «Итог» дважды вышел короче нормы.
      asked = `${prompt}\n\n${retryNote(key, body.length)}`;
    }

    this.logger.warn('report_section_dropped', {
      report_id: context.budget.reportId,
      section: key,
      code: lastCode,
      chars: lastChars,
    });

    return { ok: false, code: lastCode };
  }

  /**
   * Один вызов провайдера. Лимиты проверяются **до** следующего вызова:
   * перерасход останавливает разбор, повтор при этом не делается.
   */
  private async call(budget: Budget, messages: readonly LlmMessage[]): Promise<LlmResponse> {
    // Лимит на разбор — 80 ₽ (решение владельца), значение всегда есть.
    const reportCap = this.env.LLM_REPORT_CAP_RUB;
    if (budget.costRub >= reportCap) {
      throw new ReportFailure('cost_cap');
    }

    const monthCost = await this.repo.monthCostRub();
    if (monthCost >= this.env.LLM_MONTHLY_CAP_RUB_REPORT) {
      throw new ReportFailure('monthly_cap');
    }

    const response = await this.llm.complete({ messages });
    budget.costRub = Math.round((budget.costRub + response.usage.costRub) * 10_000) / 10_000;
    budget.attempts += 1;
    await this.repo.addCost(
      budget.reportId,
      {
        costRub: response.usage.costRub,
        promptTokens: response.usage.promptTokens,
        completionTokens: response.usage.completionTokens,
      },
      1,
    );

    if (budget.costRub > reportCap) {
      throw new ReportFailure('cost_cap');
    }

    return response;
  }

  /** Дисклеймер нужен и вне промпта: `GET` не должен отдавать «Итог» без него. */
  static readonly DISCLAIMER = DISCLAIMER;

  /** Правила главы — для судьи; экспорт нужен тестам и будущему `judge`. */
  static rulesFor(key: Exclude<SectionKey, 'summary'>): string {
    return SECTION_RULES[key];
  }

  /** Подсказка по точности времени — экспорт для тестов промптов. */
  static noteFor(precision: TimePrecision): string {
    return TIME_PRECISION_NOTE[precision];
  }
}
