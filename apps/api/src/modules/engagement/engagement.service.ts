import { Inject, Injectable } from '@nestjs/common';
import type { AskResponse, Chart, Forecast } from '@astro-soul/shared';
import { APP_ENV } from '../../config/env.module';
import type { AppEnv } from '../../config/env';
import { ApiError, notFound, validationFailed } from '../../common/api-error';
import { JsonLogger } from '../../common/logger';
import { EntitlementsService } from '../entitlements/entitlements.service';
import type { LlmMessage, LlmProvider, LlmResponse } from '../llm/llm.client';
import { LLM_PROVIDER } from '../llm/llm.module';
import { QuotasService } from '../quotas/quotas.service';
import { chartFactLabels, serializeChartFacts } from '../reports/chart-facts';
import { TelegramClient } from '../telegram/telegram.client';
import { UsersRepository } from '../users/users.repository';
import { buildMiniAppUrl, buildShareLink } from '../charts/share-link';
import { classifyTopic, forbiddenTopicOf, softRefusal } from './ask-topics';
import { parseAskRequest } from './engagement.dto';
import {
  EngagementRepository,
  type ForecastCandidate,
  type PushCandidate,
} from './engagement.repository';
import { ENGAGEMENT_SYSTEM_PROMPT, askPrompt, forecastPrompt } from './engagement.prompts';
import { NIGHTLY_HOUR, PUSH_HOUR, WINDOW_MINUTES, localParts } from './local-time';

/** Фокус дня — закрытый список контракта. Всё остальное от модели — `null`. */
const FOCUSES = ['career', 'love', 'money', 'health', 'self'] as const;
type Focus = (typeof FOCUSES)[number];

/** Ответ «спроси карту» длиннее контракта обрезаем, а не роняем (1500). */
const ANSWER_MAX = 1_500;
/** based_on — не больше пяти позиций: это подпись, а не список фактов. */
const BASED_ON_MAX = 5;

export interface NightlyResult {
  readonly generated: number;
  readonly skipped: number;
  readonly failed: number;
}

export interface PushRunResult {
  readonly sent: number;
  readonly skippedInactive: number;
  readonly deferred: number;
  readonly failed: number;
  readonly blocked: number;
}

function stripJsonFence(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/u.exec(trimmed);
  return fenced?.[1] ?? trimmed;
}

/** Первые 1–2 предложения — крючок для пуша, а не весь прогноз. */
export function pushHook(text: string): string {
  const sentences = text
    .replace(/\s+/gu, ' ')
    .split(/(?<=[.!?…])\s+/u)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence !== '');

  const hook = sentences.slice(0, 2).join(' ');

  if (hook.length <= 320) {
    return hook;
  }

  return `${hook.slice(0, 317).replace(/\s+\S*$/u, '')}…`;
}

function focusOf(value: unknown): Focus | null {
  return typeof value === 'string' && (FOCUSES as readonly string[]).includes(value)
    ? (value as Focus)
    : null;
}

interface ParsedForecast {
  readonly text: string;
  readonly focus: Focus | null;
}

function parseForecast(raw: string, paid: boolean): ParsedForecast {
  const body = stripJsonFence(raw);

  try {
    const parsed = JSON.parse(body) as { text?: unknown; focus?: unknown };
    const text = typeof parsed.text === 'string' ? parsed.text.trim() : '';
    if (text !== '') {
      return { text, focus: paid ? focusOf(parsed.focus) : null };
    }
  } catch {
    // Модель ответила не JSON — берём текст как есть: прогноз из-за формата
    // терять нельзя, а поле `focus` необязательное.
  }

  return { text: body.trim(), focus: null };
}

/**
 * Оставляем только те `based_on`, что совпадают с метками фактов карты.
 * Сравнение без регистра и лишних пробелов: модель может вернуть
 * «луна в льве» строчными или с добавкой «, 12-й дом».
 */
/**
 * `429 QUOTA_EXCEEDED` на исчерпанный дневной лимит вопросов. `reset_at` —
 * местная полночь места рождения: фронт показывает «вернись в 00:00».
 */
function quotaExhausted(resetAt: string): ApiError {
  return new ApiError('QUOTA_EXCEEDED', 429, {
    message: 'На сегодня вопросы закончились. Лимит обновится в полночь по месту рождения',
    reason: 'ask_daily_exhausted',
    details: { quota_code: 'ask_daily', reset_at: resetAt, unlimited: false },
  });
}

export function filterBasedOn(items: readonly string[], labels: readonly string[]): string[] {
  const normalize = (value: string): string => value.toLowerCase().replace(/\s+/gu, ' ').trim();
  const known = new Set(labels.map(normalize));

  return items
    .filter((item) => {
      const normalized = normalize(item);
      return [...known].some((label) => normalized === label || normalized.startsWith(`${label},`));
    })
    .slice(0, BASED_ON_MAX);
}

function basedOnOf(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((item): item is string => typeof item === 'string' && item.trim() !== '')
    .map((item) => item.trim().slice(0, 120))
    .slice(0, BASED_ON_MAX);
}

/**
 * Удержание: ночной прогноз (генерация), пуш (отправка) и «спроси карту».
 *
 * Железное правило: **прогноз никогда не генерируется в момент запроса**.
 * `GET /engagement/forecast` только читает строку, которую ночью положил
 * джоб; нет строки — `404`, а не 20 секунд ожидания при открытии мини-аппа.
 */
@Injectable()
export class EngagementService {
  constructor(
    @Inject(EngagementRepository) private readonly repo: EngagementRepository,
    @Inject(EntitlementsService) private readonly entitlements: EntitlementsService,
    @Inject(QuotasService) private readonly quotas: QuotasService,
    @Inject(UsersRepository) private readonly users: UsersRepository,
    @Inject(LLM_PROVIDER) private readonly llm: LlmProvider,
    @Inject(TelegramClient) private readonly telegram: TelegramClient,
    @Inject(APP_ENV) private readonly env: AppEnv,
    @Inject(JsonLogger) private readonly logger: JsonLogger,
  ) {}

  /** Пояс карты; без пояса прогноз не имеет смысла — `UTC` как последний шанс. */
  private static timeZoneOf(chart: Chart): string {
    return chart.birth?.place?.tz ?? 'UTC';
  }

  /**
   * `GET /engagement/forecast`: только чтение кэша.
   *
   * Дата — местная дата места рождения: у человека в Новосибирске «сегодня»
   * наступает раньше, чем на сервере.
   */
  async getForecast(
    auth: { readonly telegramUserId: bigint },
    chartId: string | undefined,
  ): Promise<Forecast> {
    if (chartId === undefined || chartId === '') {
      throw validationFailed({
        message: 'Нужна карта, для которой показываем прогноз',
        reason: 'chart_id_required',
        details: { field_errors: [{ field: 'chart_id', message: 'Выбери карту' }] },
      });
    }

    const userId = this.users.userIdFor(auth.telegramUserId);
    const chart = await this.repo.chartForUser(chartId, userId);

    if (chart === null) {
      // Контракт 1.5.6: `details.reason` — машинный признак, по нему клиент
      // уходит в онбординг. Текст читать приложению нельзя.
      throw notFound({
        message: 'Такой карты нет. Построй карту заново',
        reason: 'no_chart',
        details: { reason: 'no_chart' },
      });
    }

    const tz = EngagementService.timeZoneOf(chart.data.chart);
    const local = localParts(new Date(), tz);

    if (local === null) {
      throw notFound({
        message: 'Прогноз ещё не готов',
        reason: 'not_ready',
        details: { reason: 'not_ready' },
      });
    }

    const forecast = await this.repo.forecastFor(chartId, local.date);

    if (forecast === null) {
      // Контракт: 404, пока джоб не положил строку. Никакой генерации здесь.
      // `not_ready` — «останься на экране ожидания», `no_chart` — «в онбординг»:
      // раньше оба смысла различались только текстом, и приложение после
      // каждого 404 перечитывало `GET /me` (контракт 1.5.6, B-2).
      throw notFound({
        message: 'Прогноз на сегодня ещё готовится. Загляни чуть позже',
        reason: 'not_ready',
        details: { reason: 'not_ready' },
      });
    }

    // `forecast.is_paid` — состояние на момент генерации, а право читать полный
    // текст проверяется **сейчас** (задача D). Человек мог отменить подписку
    // между ночным джобом и открытием экрана: тогда он получает урезанный
    // прогноз, а не копию, оплаченную вчера.
    const entitlements = await this.entitlements.getEntitlements(userId);
    const paidNow = forecast.is_paid && entitlements.fullForecast;
    const text = paidNow ? (forecast.full_text ?? forecast.teaser ?? '') : (forecast.teaser ?? '');

    return {
      date: forecast.date,
      text,
      focus: focusOf(forecast.focus),
      is_paid: paidNow,
      generated_at: forecast.created_at.toISOString(),
    };
  }

  /**
   * `POST /engagement/ask`.
   *
   * Порядок намеренный:
   *   1. мягкий отказ по запрещённой теме — **до** модели и до списания квоты
   *      (это бесплатно и не должно тратить лимит);
   *   2. проверка и списание квоты — **до** модели: иначе отказ по лимиту
   *      стоил бы токенов, а две параллельные единицы прошли бы обе;
   *   3. вызов модели, разбор ответа и запись строки без текста вопроса.
   *      Упавшая модель возвращает списанную единицу.
   */
  async ask(auth: { readonly telegramUserId: bigint }, body: unknown): Promise<AskResponse> {
    const input = parseAskRequest(body);
    const userId = this.users.userIdFor(auth.telegramUserId);
    const chart = await this.repo.chartForUser(input.chart_id, userId);

    if (chart === null) {
      // Вопросу без карты некуда идти: `no_chart` — сигнал «построй карту
      // заново», а не «попробуй позже» (контракт 1.5.6, B-1).
      throw notFound({
        message: 'Карты нет. Построй её заново',
        reason: 'no_chart',
        details: { reason: 'no_chart' },
      });
    }

    const tz = EngagementService.timeZoneOf(chart.data.chart);
    const entitlements = await this.entitlements.getEntitlements(userId);
    const now = new Date();
    const existing = await this.quotas.one(userId, 'ask_daily', entitlements, now, tz);
    const topic = classifyTopic(input.question);

    // 1. Запрещённая тема: это 200 с человеческим текстом, а не 4xx —
    // содержательный вопрос не должен выглядеть поломкой.
    const forbidden = forbiddenTopicOf(input.question);

    if (forbidden !== null) {
      this.logger.info('ask_refused', { topic: forbidden, length: input.question.length });
      return { answer: softRefusal(forbidden), based_on: [], quota: existing };
    }

    // 2. Квота до вызова модели.
    if (existing.limit >= 0 && existing.used >= existing.limit) {
      throw quotaExhausted(existing.reset_at);
    }

    const monthCost = await this.repo.monthEngagementCostRub();
    if (monthCost >= this.env.LLM_MONTHLY_CAP_RUB_FORECAST) {
      this.logger.warn('ask_budget_exhausted', { month_cost_rub: monthCost });
      throw new ApiError('QUOTA_EXCEEDED', 429, {
        message: 'Вопросы временно недоступны. Попробуй позже',
        reason: 'llm_monthly_cap',
        details: { quota_code: 'ask_daily', reset_at: existing.reset_at },
      });
    }

    // Квоту списываем **до** модели, а не после: два параллельных запроса
    // иначе оба пройдут проверку и оба сходят в LLM, а последняя единица
    // лимита окажется потрачена дважды. Упавшая модель единицу вернёт.
    const consumed = await this.quotas.consume(userId, 'ask_daily', entitlements, now, tz);

    if (!consumed.allowed) {
      throw quotaExhausted(consumed.quota.reset_at);
    }

    // 3. Модель.
    const facts = serializeChartFacts(chart.data.chart);
    let response: LlmResponse;
    try {
      response = await this.complete(askPrompt({ facts, question: input.question }), { maxTokens: 700 });
    } catch (error) {
      await this.quotas.release(userId, 'ask_daily', now, tz);
      throw error;
    }
    const parsed = this.parseAnswer(response.content);
    const answer = parsed.answer.slice(0, ANSWER_MAX);
    // `based_on` — только реальные позиции карты. Модель любит дописывать
    // «ретроgrade Меркурий» и «Лилит в 8-м»: такие строки отбрасываем, иначе
    // под ответом появится опора, которой в карте нет.
    const basedOn = filterBasedOn(parsed.basedOn, chartFactLabels(chart.data.chart));

    await this.repo.insertAsk({
      userId,
      chartId: chart.id,
      questionLength: input.question.length,
      topic,
      answer,
      basis: basedOn,
      costRub: response.usage.costRub,
      tokensIn: response.usage.promptTokens,
      tokensOut: response.usage.completionTokens,
    });

    // В лог — только тема и длина. Текст вопроса и ответа в логах не место.
    this.logger.info('ask_answered', {
      topic,
      length: input.question.length,
      based_on_count: basedOn.length,
    });

    return { answer, based_on: basedOn, quota: consumed.quota };
  }

  private parseAnswer(raw: string): { answer: string; basedOn: string[] } {
    const body = stripJsonFence(raw);

    try {
      const parsed = JSON.parse(body) as { answer?: unknown; based_on?: unknown };
      if (typeof parsed.answer === 'string' && parsed.answer.trim() !== '') {
        return { answer: parsed.answer.trim(), basedOn: basedOnOf(parsed.based_on) };
      }
    } catch {
      // Не JSON — отдаём текст, `based_on` пустой: выдумывать позиции нельзя.
    }

    return { answer: body.trim(), basedOn: [] };
  }

  private async complete(prompt: string, options: { readonly maxTokens?: number } = {}): Promise<LlmResponse> {
    const messages: LlmMessage[] = [
      { role: 'system', content: ENGAGEMENT_SYSTEM_PROMPT },
      { role: 'user', content: prompt },
    ];

    return this.llm.complete({
      messages,
      ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
    });
  }

  /**
   * Ночная генерация: один прогноз на карту в местную дату.
   *
   * Счётчики джоба: `generated` — новая строка; `skipped` — уже была (или
   * упёрлись в месячный лимит); `failed` — модель ответила ошибкой, джоб идёт
   * дальше.
   */
  async runNightly(at: Date = new Date()): Promise<NightlyResult> {
    const start = NIGHTLY_HOUR * 60 - WINDOW_MINUTES;
    const end = NIGHTLY_HOUR * 60 + WINDOW_MINUTES;
    const candidates = await this.repo.forecastCandidates(at, start, end);

    let generated = 0;
    let skipped = 0;
    let failed = 0;
    let monthCost = await this.repo.monthEngagementCostRub();

    for (const candidate of candidates) {
      if (monthCost >= this.env.LLM_MONTHLY_CAP_RUB_FORECAST) {
        skipped += 1;
        continue;
      }

      try {
        const result = await this.generateForecast(candidate, at, monthCost);
        monthCost += result.costRub;

        if (result.stored) {
          generated += 1;
        } else {
          skipped += 1;
        }
      } catch (error) {
        failed += 1;
        this.logger.error('forecast_failed', {
          chart_id: candidate.chart_id,
          reason: error instanceof Error ? error.name : 'unknown',
        });
      }
    }

    if (candidates.length > 0) {
      this.logger.info('forecast_nightly', { found: candidates.length, generated, skipped, failed });
    }

    return { generated, skipped, failed };
  }

  private async generateForecast(
    candidate: ForecastCandidate,
    at: Date,
    monthCost: number,
  ): Promise<{ stored: boolean; costRub: number }> {
    const local = localParts(at, candidate.tz);

    if (local === null) {
      return { stored: false, costRub: 0 };
    }

    const chart = candidate.data.chart;
    const facts = serializeChartFacts(chart);
    const prompt = forecastPrompt({ facts, date: local.date, paid: candidate.paid });
    const response = await this.complete(prompt, { maxTokens: candidate.paid ? 700 : 400 });
    const parsed = parseForecast(response.content, candidate.paid);

    if (parsed.text === '') {
      throw new Error('empty_forecast');
    }

    // Дешёвая страховка: запрещённые темы не должны попасть в пуш и мини-апп.
    if (/диагноз|заболев|смерт|умр[её]|кармическ|порч|предназначен/iu.test(parsed.text)) {
      throw new Error('forbidden_topic');
    }

    const fullText = candidate.paid ? parsed.text : null;
    const teaser = candidate.paid ? pushHook(parsed.text) : parsed.text;

    const id = await this.repo.insertForecast({
      chartId: candidate.chart_id,
      date: local.date,
      teaser,
      fullText,
      focus: parsed.focus,
      isPaid: candidate.paid,
      costRub: response.usage.costRub,
      tokensIn: response.usage.promptTokens,
      tokensOut: response.usage.completionTokens,
    });

    this.logger.info('forecast_generated', {
      chart_id: candidate.chart_id,
      paid: candidate.paid,
      stored: id !== null,
      month_cost_rub: Math.round((monthCost + response.usage.costRub) * 100) / 100,
    });

    return { stored: id !== null, costRub: response.usage.costRub };
  }

  /**
   * Пуш 08:00 по местному времени.
   *
   * В итерации 37 (`// round37`) сюда придёт фильтр согласия
   * (`users.push_enabled`) и запись в `push_log`. Сейчас пуш уходит всем,
   * кому положен по активности, а
   * `users.push_enabled` хранится, но не читается: `Me.notifications` и
   * `POST /me/notifications` (итерация 36) уже пишут согласие, а сама отправка
   * появится в итерации 37 вместе с журналом `push_log`. Не реализовывать
   * здесь ничего до этой итерации — иначе переключатель в интерфейсе начнёт
   * действовать раньше, чем фронт его нарисует.
   *
   * - только тем, кто заходил за последние 7 дней (иначе бот пишет тем, кто
   *   забыл о нём, и получает блокировки, которые не отменить);
   * - 403 от Bot API — помечаем карту и больше не пишем;
   * - 429 — `deferred`: в этом прогоне не ретраим.
   */
  async runPush(at: Date = new Date()): Promise<PushRunResult> {
    const start = PUSH_HOUR * 60 - WINDOW_MINUTES;
    const end = PUSH_HOUR * 60 + WINDOW_MINUTES;
    const candidates = await this.repo.pushCandidates(at, start, end);
    const skippedInactive = await this.repo.countPushInactive(at, start, end);

    let sent = 0;
    let deferred = 0;
    let failed = 0;
    let blocked = 0;

    for (const candidate of candidates) {
      const outcome = await this.pushOne(candidate);

      if (outcome === 'sent') {
        sent += 1;
      } else if (outcome === 'blocked') {
        blocked += 1;
      } else if (outcome === 'deferred') {
        deferred += 1;
      } else {
        failed += 1;
      }
    }

    if (candidates.length > 0) {
      this.logger.info('forecast_push', { found: candidates.length, sent, blocked, deferred, failed });
    }

    return { sent, skippedInactive, deferred, failed, blocked };
  }

  private async pushOne(candidate: PushCandidate): Promise<'sent' | 'blocked' | 'deferred' | 'failed'> {
    if (candidate.telegram_id === null || candidate.text === null || candidate.text.trim() === '') {
      return 'failed';
    }

    const hook = pushHook(candidate.text);
    const button = this.openButton(candidate.chart_id);
    const outcome = await this.telegram.sendPush(
      Number(candidate.telegram_id),
      `${hook}\n\nПолный прогноз — в приложении.`,
      button === null ? {} : { button },
    );

    if (outcome === 'sent') {
      await this.repo.markPushSent(candidate.forecast_id);
    } else if (outcome === 'blocked') {
      await this.repo.markPushBlocked(candidate.chart_id);
    }

    // 429 — «в этом прогоне не ретраим», это и есть `deferred`.
    const mapped = outcome === 'rate_limited' ? 'deferred' : outcome;
    this.logger.info('push_attempt', { chart_id: candidate.chart_id, outcome: mapped });
    return mapped;
  }

  /** Кнопка «Открыть»: мини-апп на нужной карте, иначе ссылка на бота. */
  private openButton(chartId: string): { text: string; webAppUrl: string } | null {
    const url =
      buildMiniAppUrl(this.env.MINI_APP_URL, chartId) ?? buildShareLink(this.env.BOT_USERNAME, chartId);
    return url === null ? null : { text: 'Открыть', webAppUrl: url };
  }

  /** Сколько стоит удержание за месяц — для логов и метрик. */
  async monthCostRub(): Promise<number> {
    return this.repo.monthEngagementCostRub();
  }
}
