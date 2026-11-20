import { Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { Chart } from '@astro-soul/shared';
import type { VerifiedInitData } from '../auth/init-data';
import { APP_ENV } from '../../config/env.module';
import type { AppEnv } from '../../config/env';
import { ApiError, notFound, validationFailed } from '../../common/api-error';
import { JsonLogger } from '../../common/logger';
import { pageLimit, pageOffset } from '../../common/paging';
import { ChartsRepository } from '../charts/charts.repository';
import { EntitlementsService } from '../entitlements/entitlements.service';
import { EventsRepository } from '../events/events.repository';
import { LLM_PROVIDER } from '../llm/llm.module';
import type { LlmProvider, LlmResponse } from '../llm/llm.client';
import { localParts, nextLocalMidnight } from '../engagement/local-time';
import { chartFactLabels } from '../reports/chart-facts';
import { UsersRepository } from '../users/users.repository';
import { DailyForecastRepository } from './daily-forecast.repository';
import { parseQuestionRequest, QUESTION_MAX, QUESTION_MIN } from './questions.dto';
import { questionPrompt, QUESTION_SYSTEM_PROMPT } from './questions.prompts';
import { QuestionsRepository, type QuestionRow } from './questions.repository';
import { REFUSAL_TEXT, refusalOf, topicOf, type RefusalReason } from './questions.topics';
import {
  QUESTION_DISCLAIMER,
  finalizeQuestion,
  forbiddenOfQuestion,
  parseQuestionAnswer,
  questionFromBody,
  type QuestionSectionView,
} from './questions.validators';

/**
 * Дневная квота вопросов — та, что видит клиент.
 *
 * `resets_at` — местная полночь места рождения: «вернись в 00:00» должно
 * означать полночь человека, а не сервера.
 */
export interface QuestionQuota {
  readonly used: number;
  readonly limit: number;
  readonly resets_at: string;
}

export interface QuestionView {
  readonly id: string;
  readonly status: 'pending' | 'ready' | 'failed' | 'refused';
  readonly question: string;
  readonly sections: readonly QuestionSectionView[];
  readonly chars: number;
  readonly warnings: readonly string[];
  readonly reason: string | null;
  readonly topic: string;
  readonly message: string | null;
  readonly created_at: string;
  readonly disclaimer: string;
  readonly quota: QuestionQuota;
}

export interface QuestionList {
  readonly items: readonly QuestionView[];
  readonly quota: QuestionQuota;
  /** Сколько записей всего (после фильтра, до `LIMIT`). */
  readonly total: number;
  /** Сколько запрошено и с какого смещения — чтобы клиент не гадал. */
  readonly limit: number;
  readonly offset: number;
}

export interface QuestionAccepted {
  readonly id: string;
  readonly status: 'pending' | 'refused';
  readonly quota: QuestionQuota;
}

/** Сколько вопросов можно запросить за один листинг. */
export const QUESTIONS_PAGE_MAX = 20;

@Injectable()
export class QuestionsService {
  constructor(
    @Inject(APP_ENV) private readonly env: AppEnv,
    @Inject(UsersRepository) private readonly users: UsersRepository,
    @Inject(ChartsRepository) private readonly charts: ChartsRepository,
    @Inject(DailyForecastRepository) private readonly profile: DailyForecastRepository,
    @Inject(QuestionsRepository) private readonly repo: QuestionsRepository,
    @Inject(LLM_PROVIDER) private readonly llm: LlmProvider,
    @Inject(EntitlementsService) private readonly entitlements: EntitlementsService,
    @Inject(EventsRepository) private readonly events: EventsRepository,
    @Inject(JsonLogger) private readonly logger: JsonLogger,
  ) {}

  /**
   * `POST /api/v1/questions`.
   *
   * Порядок проверок задан деньгами и здравым смыслом: отказ по теме и лимиты
   * считаются **до** вставки и до модели, иначе «вопрос про таблетки» списывал
   * бы квоту, а исчерпанный лимит — деньги.
   */
  async ask(auth: VerifiedInitData, body: unknown, idempotencyKey: string | undefined): Promise<QuestionAccepted> {
    const userId = this.users.userIdFor(auth.telegramUserId);
    const parsed = parseQuestionRequest(body, idempotencyKey);

    const chart = await this.charts.findLatestByUser(userId);
    if (chart === null) {
      throw notFound({
        message: 'Такой карты нет. Построй карту заново',
        reason: 'chart_not_found',
        details: { reason: 'chart_not_found' },
      });
    }

    const context = await this.localContext(userId);
    await this.requireSubscription(userId);

    const topic = topicOf(parsed.text);
    const hash = questionHash(parsed.text);

    // Отказ — до квоты и до модели: причина из закрытого списка, текст
    // константный, расход нулевой. Строку сохраняем, чтобы человек видел
    // историю и не задавал тот же вопрос заново.
    const refusal = refusalOf(parsed.text);
    if (refusal !== null) {
      const row = await this.insertOrResolve({
        userId,
        parsed,
        context,
        topic,
        hash,
        refusal,
      });

      if (row.status === 'refused') {
        await this.events.log({ name: 'question_refused', userId, props: { reason: refusal, topic } });
      }

      return {
        id: row.id,
        status: row.status === 'refused' ? 'refused' : 'pending',
        quota: await this.quota(userId, context),
      };
    }

    await this.requireBudget(userId, context);

    const taken = await this.repo.takeQuota(userId, context.date, this.env.QUESTION_DAILY_LIMIT);
    if (!taken) {
      throw this.quotaExhausted(userId, context);
    }

    const outcome = await this.repo.insert({
      userId,
      localDate: context.date,
      timezone: context.timezone,
      question: parsed.text,
      questionHash: hash,
      topic,
      idemKey: parsed.idemKey,
      engineVersion: this.env.ENGINE_VERSION,
      promptVersion: this.env.PROMPT_VERSION_QUESTION,
    });

    if (outcome.kind === 'in_progress') {
      // Квоту вернули: модели не было, значит и траты нет. Иначе быстрый
      // двойной тап съедал бы две попытки из трёх.
      await this.repo.refundQuota(userId, context.date);
      throw new ApiError('CONFLICT', 409, {
        reason: 'question_in_progress',
        message: 'Предыдущий вопрос ещё готовится — дождись ответа',
        details: { reason: 'question_in_progress' },
      });
    }

    if (outcome.kind === 'duplicate') {
      await this.repo.refundQuota(userId, context.date);
      return {
        id: outcome.row.id,
        status: outcome.row.status === 'refused' ? 'refused' : 'pending',
        quota: await this.quota(userId, context),
      };
    }

    // Ответ считается в фоне: 202 отвечает сразу, иначе HTTP-запрос держал бы
    // соединение всё время генерации.
    void this.generate(outcome.row, chart.data.chart as Chart, topic, userId);

    return {
      id: outcome.row.id,
      status: 'pending',
      quota: await this.quota(userId, context),
    };
  }

  /** `GET /api/v1/questions/{id}`. */
  async get(auth: VerifiedInitData, id: string): Promise<QuestionView> {
    const userId = this.users.userIdFor(auth.telegramUserId);
    const row = await this.repo.findById(id, userId);
    if (row === null) {
      throw notFound({
        message: 'Такого вопроса нет. Обнови приложение',
        reason: 'question_not_found',
        details: { reason: 'question_not_found' },
      });
    }

    return this.toView(row, await this.quota(userId, await this.localContext(userId)));
  }

  /** `GET /api/v1/questions?limit=20`. */
  async list(
    auth: VerifiedInitData,
    limit: string | undefined,
    offset?: string,
  ): Promise<QuestionList> {
    const userId = this.users.userIdFor(auth.telegramUserId);
    const size = pageLimit(limit, QUESTIONS_PAGE_MAX);
    const skip = pageOffset(offset);

    const [rows, total, quota] = await Promise.all([
      this.repo.list(userId, size, skip),
      this.repo.count(userId),
      this.quota(userId, await this.localContext(userId)),
    ]);

    return {
      items: rows.map((row) => this.toView(row, quota)),
      quota,
      total,
      limit: size,
      offset: skip,
    };
  }

  /**
   * Генерация ответа — в фоне после `202`.
   *
   * Ошибки не пробрасываются в HTTP (ответ уже отдан): строка становится
   * `failed`, квота возвращается, а в истории (`GET /questions`) записи не
   * будет — 1.6.7 прячет провалы из списков, по `id` они доступны. Текст
   * вопроса в логи не попадает — только хеш, длина и тема.
   */
  private async generate(
    row: QuestionRow,
    chart: Chart,
    topic: string,
    userId: string,
  ): Promise<void> {
    const started = Date.now();

    try {
      const response = await this.llm.complete({
        messages: [
          { role: 'system', content: QUESTION_SYSTEM_PROMPT },
          { role: 'user', content: questionPrompt({ question: row.question, chart }) },
        ],
        temperature: 0.6,
        maxTokens: 1_200,
      });

      await this.repo.addCost(row.id, response.usage.costRub);
      this.checkCap(row.id, response, row);

      const text = this.textOf(response.content, chart, row);
      await this.repo.markReady(row.id, text.bodyMd, text.chars, text.warnings);

      await this.events.log({
        name: 'question_ready',
        userId,
        props: {
          topic,
          question_hash: row.question_hash,
          question_len: row.question_len,
          chars: text.chars,
          warnings: text.warnings,
          cost_rub: round4(response.usage.costRub),
        },
      });

      this.logger.info('question_ready', {
        question_hash: row.question_hash,
        question_len: row.question_len,
        topic,
        ms: Date.now() - started,
      });
    } catch (error) {
      const reason = this.errorCodeOf(error);
      await this.repo.markFailed(row.id, reason);
      // Неудача не стоит человеку попытки: квота возвращается тем же движением,
      // что списывалась. Иначе три сбоя подряд означали бы «вопросы кончились»
      // при нуле ответов — и `failed` приходилось бы показывать в истории,
      // чтобы это было хоть как-то объяснимо. Решение владельца (1.6.7)
      // обратное: `failed` не показываем, значит и платить за него нельзя.
      await this.repo.refundQuota(userId, row.local_date);
      // Текст вопроса в лог не идёт — правило 1.6.6 действует и на сбоях.
      this.logger.warn('question_failed', {
        question_hash: row.question_hash,
        question_len: row.question_len,
        topic,
        error_code: reason,
        // Тот же смысл, что `error_code`, под общим для логов ключом `reason`:
        // сам код не переименовываем, старые запросы по `error_code` живы.
        reason,
      });
    }
  }

  /** Потолок на один ответ: проверяется после вызова, как у прогноза. */
  private checkCap(id: string, response: LlmResponse, row: QuestionRow): void {
    if (response.usage.costRub <= this.env.LLM_QUESTION_CAP_RUB) {
      return;
    }

    this.logger.error('question_cap_exceeded', {
      question_hash: row.question_hash,
      cost_rub: round4(response.usage.costRub),
      cap_rub: this.env.LLM_QUESTION_CAP_RUB,
    });
    throw new ApiError('INTERNAL', 500, { reason: 'question_cap_exceeded' });
  }

  private textOf(
    raw: string,
    chart: Chart,
    row: QuestionRow,
  ): { bodyMd: string; chars: number; warnings: readonly string[] } {
    const parsed = parseQuestionAnswer(raw);
    if (parsed === null) {
      throw new Error('question_bad_format');
    }

    const forbidden = forbiddenOfQuestion(Object.values(parsed).join('\n'));
    if (forbidden !== null) {
      this.logger.warn('question_forbidden_content', {
        question_hash: row.question_hash,
        rule: forbidden,
      });
      throw new Error('question_forbidden_content');
    }

    const text = finalizeQuestion({ parsed, labels: chartFactLabels(chart) });
    if (text === null) {
      throw new Error('question_incomplete');
    }

    return { bodyMd: text.bodyMd, chars: text.chars, warnings: text.warnings };
  }

  /**
   * Вставка вопроса с отказом.
   *
   * Отказ не тратит квоту, поэтому `takeQuota` здесь не вызывается. Повтор с
   * тем же `Idempotency-Key` вернёт ту же строку — текст отказа не меняется.
   */
  private async insertOrResolve(input: {
    userId: string;
    parsed: { text: string; idemKey: string };
    context: { date: string; timezone: string };
    topic: string;
    hash: string;
    refusal: RefusalReason;
  }): Promise<QuestionRow> {
    const outcome = await this.repo.insert({
      userId: input.userId,
      localDate: input.context.date,
      timezone: input.context.timezone,
      question: input.parsed.text,
      questionHash: input.hash,
      topic: input.topic,
      idemKey: input.parsed.idemKey,
      engineVersion: this.env.ENGINE_VERSION,
      promptVersion: this.env.PROMPT_VERSION_QUESTION,
    });

    if (outcome.kind === 'created') {
      await this.repo.markRefused(outcome.row.id, input.refusal);
      const refused = await this.repo.findById(outcome.row.id, input.userId);
      return refused ?? outcome.row;
    }

    if (outcome.kind === 'duplicate') {
      return outcome.row;
    }

    throw new ApiError('CONFLICT', 409, {
      reason: 'question_in_progress',
      message: 'Предыдущий вопрос ещё готовится — дождись ответа',
      details: { reason: 'question_in_progress' },
    });
  }

  private async requireSubscription(userId: string): Promise<void> {
    if (this.env.QUESTION_FOR_NON_SUBSCRIBERS === '1') {
      return;
    }

    const entitlements = await this.entitlements.getEntitlements(userId);
    if (!entitlements.isActive) {
      throw new ApiError('FORBIDDEN', 403, {
        reason: 'subscription_required',
        message: 'Вопросы карте входят в подписку',
        details: { reason: 'subscription_required' },
      });
    }
  }

  /**
   * Дневной потолок расходов на вопросы.
   *
   * `429`, а не молчание: человек должен понимать, что лимит на сегодня, а не
   * что приложение сломалось. Считаем по фактическим расходам строк за
   * местную дату — это то, что реально потрачено.
   */
  private async requireBudget(userId: string, context: { date: string; timezone: string }): Promise<void> {
    const spent = await this.repo.costToday(userId, context.date);
    if (spent < this.env.LLM_QUESTION_DAILY_CAP_RUB) {
      return;
    }

    throw new ApiError('QUOTA_EXCEEDED', 429, {
      reason: 'daily_cost_cap',
      message: 'На сегодня лимит вопросов исчерпан — возвращайся завтра',
      details: {
        reason: 'daily_cost_cap',
        resets_at: nextLocalMidnight(new Date(), context.timezone).toISOString(),
      },
    });
  }

  private quotaExhausted(
    userId: string,
    context: { date: string; timezone: string },
  ): ApiError {
    return new ApiError('FORBIDDEN', 403, {
      reason: 'quota_exhausted',
      message: 'На сегодня вопросы закончились',
      details: {
        reason: 'quota_exhausted',
        quota: {
          used: this.env.QUESTION_DAILY_LIMIT,
          limit: this.env.QUESTION_DAILY_LIMIT,
          resets_at: nextLocalMidnight(new Date(), context.timezone).toISOString(),
        },
        resets_at: nextLocalMidnight(new Date(), context.timezone).toISOString(),
      },
      logFields: { user_id_tail: userId.slice(-6) },
    });
  }

  private async quota(
    userId: string,
    context: { date: string; timezone: string },
  ): Promise<QuestionQuota> {
    const used = await this.repo.usedToday(userId, context.date);
    return {
      used,
      limit: this.env.QUESTION_DAILY_LIMIT,
      resets_at: nextLocalMidnight(new Date(), context.timezone).toISOString(),
    };
  }

  private async localContext(userId: string): Promise<{ date: string; timezone: string }> {
    const timezone = await this.profile.profileTimezone(userId);
    if (timezone === null) {
      throw validationFailed({
        reason: 'profile_required',
        details: { reason: 'profile_required' },
      });
    }

    const local = localParts(new Date(), timezone);
    if (local === null) {
      throw new ApiError('INTERNAL', 503, { reason: 'timezone_invalid' });
    }

    return { date: local.date, timezone };
  }

  private toView(row: QuestionRow, quota: QuestionQuota): QuestionView {
    const parsed = row.body_md === null ? { sections: [], chars: 0 } : questionFromBody(row.body_md);

    return {
      id: row.id,
      status: row.status,
      question: row.question,
      // У отказа и провала разделов нет — текст отказа постоянный и берётся из
      // константы, чтобы формулировка не зависела от модели.
      sections: parsed.sections,
      chars: row.chars ?? parsed.chars,
      warnings: row.warnings,
      reason: row.reason,
      topic: row.topic,
      message:
        row.status === 'refused' && row.reason !== null
          ? (REFUSAL_TEXT[row.reason as RefusalReason] ?? null)
          : null,
      created_at: row.created_at.toISOString(),
      disclaimer: QUESTION_DISCLAIMER,
      quota,
    };
  }

  private errorCodeOf(error: unknown): string {
    if (error instanceof ApiError) {
      return error.reason ?? 'question_failed';
    }
    if (error instanceof Error) {
      return error.message.startsWith('question_') ? error.message : 'llm_error';
    }
    return 'question_failed';
  }
}

/**
 * Хеш вопроса: `sha256(text)[:16]`.
 *
 * По нему видно «тот же вопрос» в логе и нельзя восстановить текст. Длина
 * вопроса тоже хранится — она не ПДн и помогает диагностике формата.
 */
export function questionHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
}

/** Границы вопроса — для описания маршрута и тестов. */
export const QUESTION_LIMITS = { min: QUESTION_MIN, max: QUESTION_MAX } as const;

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
