import { Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { Chart } from '@astro-soul/shared';
import { ApiError, notFound } from '../../common/api-error';
import { JsonLogger } from '../../common/logger';
import { APP_ENV } from '../../config/env.module';
import type { AppEnv } from '../../config/env';
import type { VerifiedInitData } from '../auth/init-data';
import { EntitlementsService } from '../entitlements/entitlements.service';
import { LLM_PROVIDER } from '../llm/llm.module';
import { LlmError, type LlmMessage, type LlmProvider, type LlmResponse } from '../llm/llm.client';
import { UsersRepository } from '../users/users.repository';
import { serializeChartFacts } from './chart-facts';
import { serializeChartFactsExtras } from './chart-facts-extras';
import { fewShotBlocks } from './corpus';
import { buildDigest } from './digests';
import {
  chapterPrompt,
  planPrompt,
  PROMPT_VERSION,
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
  validateSection,
  type SectionKey,
  type TimePrecision,
} from './validators';

/** Шесть содержательных глав: «Итог» пишется отдельно, по их сводкам. */
const CONTENT_SECTIONS: readonly Exclude<SectionKey, 'summary'>[] = [
  'core',
  'emotions',
  'talents',
  'relations',
  'money',
  'purpose',
];

const ALL_SECTIONS: readonly SectionKey[] = [...CONTENT_SECTIONS, 'summary'];

/** Первые 400 знаков `core` — то, что видно до оплаты. */
export const TEASER_LENGTH = 400;

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
  readonly pdf_url: null;
  readonly sections: readonly ReportSectionView[];
  readonly is_paid: boolean;
  readonly teaser?: string;
}

/** Внутренний провал конвейера: код уходит в `reports.error_code`. */
class ReportFailure extends Error {
  constructor(readonly code: 'cost_cap' | 'monthly_cap' | 'validation') {
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
    @Inject(UsersRepository) private readonly users: UsersRepository,
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

    const byKey = await this.repo.findByIdempotencyKey(userId, idempotencyKey);
    if (byKey !== null) {
      return this.view(byKey, false);
    }

    const entitlement = await this.entitlements.getEntitlements(userId);
    const latest = await this.repo.latestForChart(chart.id, 'report');

    // Пока разбор собирается (или уже собран), второй заказ бессмысленен:
    // отдаём существующий, деньги не списываем.
    if (latest !== null && latest.status !== 'failed' && latest.status !== 'refunded') {
      return this.view(latest, entitlement.fullReport);
    }

    // Проверка доступа — по карте, а не по флагу `fullReport`: одна покупка
    // не должна открывать разборы по другим картам (деньги).
    const owned = await this.repo.hasReportEntitlement(userId, chart.id);
    if (!owned) {
      throw new ApiError('PAYMENT_REQUIRED', 402, {
        message: 'Полный разбор — отдельная покупка. Оформи её на экране разбора',
        reason: 'report_not_paid',
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
    });

    this.logger.info('report_queued', {
      report_id: report.id,
      model: this.llm.name,
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

    return this.view(report, entitlement.fullReport);
  }

  async get(auth: VerifiedInitData, reportId: string): Promise<ReportView> {
    const userId = this.users.userIdFor(auth.telegramUserId);
    const report = await this.repo.owned(reportId, userId);

    if (report === null) {
      throw notFound({ message: 'Такого разбора нет. Обнови приложение', reason: 'report_not_found' });
    }

    const entitlement = await this.entitlements.getEntitlements(userId);
    return this.view(report, entitlement.fullReport);
  }

  /** `chart_facts` + дополнения (аспекты к углам, управители). Только whitelist. */
  private factsFor(chart: Chart): string {
    const extras = serializeChartFactsExtras(chart);
    return extras === '' ? serializeChartFacts(chart) : `${serializeChartFacts(chart)}\n${extras}`;
  }

  private view(report: ReportRow, paid: boolean): ReportView {
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

    const view: ReportView = {
      report_id: report.id,
      chart_id: report.chart_id,
      type: report.kind === 'report' ? 'full' : (report.kind as ReportType),
      status,
      progress,
      created_at: report.created_at.toISOString(),
      ready_at: status === 'ready' ? report.updated_at.toISOString() : null,
      pdf_url: null,
      sections,
      is_paid: paid,
      ...(report.teaser === null ? {} : { teaser: report.teaser }),
    };

    return view;
  }

  /** Генерация: статусы `planning` → `writing` → `ready` (или `failed`). */
  private async run(reportId: string): Promise<void> {
    const budget: Budget = { reportId, costRub: 0, attempts: 0 };
    const sectionStatus: Partial<Record<SectionKey, 'ok' | 'regenerated' | 'failed'>> = {};
    const validation: { key: string; attempt: number; failures: readonly string[] }[] = [];

    try {
      const report = await this.repo.byId(reportId);
      if (report === null) {
        return;
      }

      const chart = await this.repo.chartForUser(report.chart_id, report.user_id);
      if (chart === null) {
        throw new ReportFailure('validation');
      }

      const facts = this.factsFor(chart.data.chart);
      const timePrecision = this.precisionOf(facts);

      await this.repo.start(reportId);

      const plan = await this.plan(facts, budget);
      await this.repo.savePlan(reportId, plan);

      const chapters: ReportChapter[] = [];
      const written: string[] = [];
      const digests: string[] = [];
      let teaser: string | null = null;

      for (const [index, key] of CONTENT_SECTIONS.entries()) {
        const { body, regenerated } = await this.section(key, {
          reportId,
          facts,
          timePrecision,
          thesis: plan.thesis,
          focusBlock: this.focusBlock(plan),
          previousSummary: digests.map((digest, position) => `${position + 1}. ${digest}`).join('\n'),
          previous: written,
          budget,
          validation,
        });

        sectionStatus[key] = regenerated ? 'regenerated' : 'ok';
        written.push(body);
        digests.push(buildDigest(body));
        chapters.push({ key, title: titleOf(key), body_md: body, order: index });

        if (key === 'core') {
          teaser = body.slice(0, TEASER_LENGTH);
        }

        await this.repo.saveProgress({ id: reportId, status: 'writing', chapters, teaser });
      }

      const summary = await this.summary({
        thesis: plan.thesis,
        timePrecision,
        digests,
        previous: written,
        budget,
        validation,
      });

      sectionStatus.summary = summary.regenerated ? 'regenerated' : 'ok';
      chapters.push({
        key: 'summary',
        title: titleOf('summary'),
        body_md: summary.body,
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
      });

      this.logger.info('report_ready', {
        report_id: reportId,
        attempts: budget.attempts,
        cost_rub: budget.costRub,
        chapters: chapters.length,
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
      await this.repo.saveDiagnostics(reportId, sectionStatus, validation);
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

    let parsed: unknown;
    try {
      parsed = JSON.parse(stripJsonFence(response.content));
    } catch {
      throw new ReportFailure('validation');
    }

    const plan = parsed as Partial<PlanJson>;
    if (typeof plan.thesis !== 'string' || !Array.isArray(plan.focuses)) {
      throw new ReportFailure('validation');
    }

    return {
      thesis: plan.thesis,
      focuses: plan.focuses,
      avoid: plan.avoid ?? [],
    };
  }

  private focusBlock(plan: PlanJson): string {
    const focuses = plan.focuses
      .map((focus, index) =>
        [
          `${index + 1}.`,
          focus.topic ?? 'тема',
          focus.factor === undefined ? '' : `(фактор: ${focus.factor})`,
          focus.angle === undefined ? '' : `— ${focus.angle}`,
        ]
          .filter((part) => part !== '')
          .join(' '),
      )
      .join('\n');

    const avoid = plan.avoid === undefined || plan.avoid.length === 0 ? '' : `\nНе повторять: ${plan.avoid.join('; ')}`;
    return `${focuses}${avoid}`;
  }

  private async section(
    key: Exclude<SectionKey, 'summary'>,
    context: {
      readonly reportId: string;
      readonly facts: string;
      readonly timePrecision: TimePrecision;
      readonly thesis: string;
      readonly focusBlock: string;
      readonly previousSummary: string;
      readonly previous: readonly string[];
      readonly budget: Budget;
      readonly validation: { key: string; attempt: number; failures: readonly string[] }[];
    },
  ): Promise<{ body: string; regenerated: boolean }> {
    const prompt = chapterPrompt({
      key,
      chartFacts: context.facts,
      thesis: context.thesis,
      focusBlock: context.focusBlock,
      previousSummary: context.previousSummary === '' ? 'пока ничего' : context.previousSummary,
      timePrecision: context.timePrecision,
      examples: fewShotBlocks(2).map((block) => block.text),
    });

    return this.withValidation(key, prompt, context);
  }

  private async summary(context: {
    readonly thesis: string;
    readonly digests: readonly string[];
    readonly timePrecision: TimePrecision;
    readonly previous: readonly string[];
    readonly budget: Budget;
    readonly validation: { key: string; attempt: number; failures: readonly string[] }[];
  }): Promise<{ body: string; regenerated: boolean }> {
    const prompt = summaryPrompt({
      thesis: context.thesis,
      digests: context.digests,
      timePrecision: context.timePrecision,
    });

    return this.withValidation('summary', prompt, {
      timePrecision: context.timePrecision,
      previous: context.previous,
      budget: context.budget,
      validation: context.validation,
    });
  }

  /**
   * Генерация с одной перегенерацией. Перегенерация — тот же промпт: правки
   * «по месту» меняли бы текст инструкции, а промпты версионируются.
   */
  private async withValidation(
    key: SectionKey,
    prompt: string,
    context: {
      readonly timePrecision: TimePrecision;
      readonly previous: readonly string[];
      readonly budget: Budget;
      readonly validation: { key: string; attempt: number; failures: readonly string[] }[];
    },
  ): Promise<{ body: string; regenerated: boolean }> {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const response = await this.call(context.budget, [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: prompt },
      ]);

      const body = response.content.trim();
      const result = validateSection({
        key,
        bodyMd: body,
        timePrecision: context.timePrecision,
        previous: context.previous,
      });

      if (result.failures.length === 0) {
        if (attempt > 1) {
          this.logger.warn('report_section_regenerated', {
            section: key,
            warnings: result.warnings,
          });
        }
        return { body, regenerated: attempt > 1 };
      }

      context.validation.push({
        key,
        attempt,
        failures: result.failures.map((failure) => `${failure.rule}: ${failure.detail}`),
      });

      if (attempt === 2) {
        throw new ReportFailure('validation');
      }
    }

    throw new ReportFailure('validation');
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
    if (monthCost >= this.env.LLM_MONTHLY_CAP_RUB) {
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
