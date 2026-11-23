import { Inject, Injectable } from '@nestjs/common';
import type { AskResponse, Chart, Forecast } from '@astro-soul/shared';
import { APP_ENV } from '../../config/env.module';
import type { AppEnv } from '../../config/env';
import { ApiError, notFound, validationFailed } from '../../common/api-error';
import { JsonLogger } from '../../common/logger';
import { EntitlementsService } from '../entitlements/entitlements.service';
import { EventsRepository } from '../events/events.repository';
import type { LlmMessage, LlmProvider, LlmResponse } from '../llm/llm.client';
import { LLM_PROVIDER } from '../llm/llm.module';
import { QuotasService } from '../quotas/quotas.service';
import { chartFactLabels, serializeChartFacts } from '../reports/chart-facts';
import { TelegramClient } from '../telegram/telegram.client';
import { UsersRepository } from '../users/users.repository';
import { AstroClient, type AstroChartData } from '../astro/astro.client';
import { buildTodayUrl } from '../charts/share-link';
import { classifyTopic, forbiddenTopicOf, softRefusal } from './ask-topics';
import { parseAskRequest } from './engagement.dto';
import { EngagementRepository, type ForecastCandidate, type PushRecipient } from './engagement.repository';
import { ENGAGEMENT_SYSTEM_PROMPT, askPrompt, forecastPrompt } from './engagement.prompts';
import {
  PUSH_MAX_CHARS,
  PUSH_OFF_CALLBACK,
  PUSH_OFF_TEXT,
  PUSH_OPEN_TEXT,
  PushTextCache,
} from './push-message';
import type { PushButton } from '../telegram/telegram.client';
import { NIGHTLY_HOUR, WINDOW_MINUTES, localParts } from './local-time';

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

/**
 * Итог одного цикла утреннего пуша.
 *
 * `enabled: false` — пуш выключен флагом, и это не ошибка: планировщик в этом
 * случае не запускается вовсе, а ручной вызов через `?job=forecast_push`
 * возвращает нули, чтобы `/health` не считал такой прогон «живым».
 */
export interface PushRunResult {
  readonly enabled: boolean;
  readonly candidates: number;
  readonly sent: number;
  readonly skippedSeen: number;
  readonly skippedNoTz: number;
  readonly duplicatePrevented: number;
  readonly deferred: number;
  readonly failed: number;
  readonly blocked: number;
  readonly ms: number;
}

/** Настройки прогона: тесты подменяют паузы, прод берёт значения по умолчанию. */
export interface PushRunOptions {
  /** Пауза перед повтором после сетевой ошибки (по умолчанию 60 с). */
  readonly retryDelayMs?: number;
  /** Пауза между сообщениями: ~30 сообщений в секунду суммарно. */
  readonly sendGapMs?: number;
  /** Ожидание можно подменить в тестах, чтобы не спать минуту. */
  readonly sleep?: (ms: number) => Promise<void>;
  /**
   * Часы процесса. Отдельная ручка нужна, чтобы тест «повтор в 08:06» не
   * зависел от реального времени суток: окно проверяется по ним.
   */
  readonly now?: () => Date;
}

/** Часы и паузы одного прогона: в проде — настоящие, в тестах — подменённые. */
interface PushTiming {
  readonly sleep: (ms: number) => Promise<void>;
  readonly retryDelayMs: number;
  readonly now: () => Date;
  /**
   * Кэш текста на прогон (1.6.14, долг 8.5): одинаковые «знак + фаза» в один
   * день дают одинаковый текст, и собирать его заново для каждого человека
   * незачем. Живёт ровно один прогон.
   */
  readonly textCache: PushTextCache;
}

/** Повтор после «прочих» ошибок — ровно один, дальше до следующего дня. */
export const PUSH_RETRIES = 1;
/** Сколько раз ждём `429`, прежде чем признать получателя `deferred`. */
export const PUSH_MAX_THROTTLE_WAITS = 3;
/** Пауза между сообщениями: 35 мс ≈ 28 сообщений в секунду. */
export const PUSH_SEND_GAP_MS = 35;
/** Повтор через минуту — как обещано в задании (окно 5 минут это позволяет). */
export const PUSH_RETRY_DELAY_MS = 60_000;
/** Предел одного цикла: дольше окна 08:00–08:04 он идти не должен. */
export const PUSH_RUN_BUDGET_MS = 5 * 60_000;

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

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
    @Inject(AstroClient) private readonly astro: AstroClient,
    @Inject(EventsRepository) private readonly events: EventsRepository,
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
   * Утренний пуш 08:00 по поясу рождения (итерация 38, контракт 1.6.13).
   *
   * Правила, которые здесь зашиты и которые нельзя «улучшить» по дороге:
   *
   *   • **окно, а не час**: получатели — те, у кого местное время попало в
   *     `[08:00, 08:04]`. Пропустили окно (лежал API, шёл деплой) — пуш в этот
   *     день не догоняется: «доброе утро» в обед хуже, чем его отсутствие;
   *   • **ровно один пуш в местные сутки**: `push_log` уникален по
   *     `(user_id, local_date, kind)`, вставка-«заявка» идёт **до** отправки.
   *     Второй запуск в ту же минуту получает конфликт и уходит в
   *     `duplicate_prevented`, а не отправляет дубль;
   *   • **текст без модели**: константы и факты дня, ≤ 200 символов;
   *   • **не мешать тем, кто уже зашёл**: `last_seen_at` после 07:30 местного —
   *     пропуск (человек увидит разбор в приложении сам);
   *   • **ошибки Bot API различаются**: `403`/`chat not found` — согласие
   *     снимается, повторять нечего; `429` — ждём `retry_after` и продолжаем с
   *     того же человека; прочее — один повтор через минуту, потом запись в
   *     `push_log.error` до следующего дня.
   *
   * Модель не вызывается ни разу: это не «ленивый прогноз», а напоминание о
   * том, что прогноз уже есть в приложении.
   */
  async runPush(at: Date = new Date(), options: PushRunOptions = {}): Promise<PushRunResult> {
    const startedAt = Date.now();
    const empty: PushRunResult = {
      enabled: false,
      candidates: 0,
      sent: 0,
      skippedSeen: 0,
      skippedNoTz: 0,
      duplicatePrevented: 0,
      deferred: 0,
      failed: 0,
      blocked: 0,
      ms: 0,
    };

    // Флаг читается в рантайме: включение пуша — рестарт API, а не деплой
    // кода (`docs/PUSH.md`). Выключенный пуш не трогает БД вовсе.
    if (this.env.PUSH_ENABLED !== '1') {
      return empty;
    }

    const sleep = options.sleep ?? defaultSleep;
    const now = options.now ?? ((): Date => new Date());
    const retryDelayMs = options.retryDelayMs ?? PUSH_RETRY_DELAY_MS;
    const sendGapMs = options.sendGapMs ?? PUSH_SEND_GAP_MS;
    const windowStart = this.env.PUSH_SEND_HOUR * 60;
    const windowEnd = windowStart + this.env.PUSH_WINDOW_MINUTES - 1;

    // Кэш текста создаётся здесь, а не в поле сервиса: между прогонами текст
    // может измениться (правка констант, деплой), и переживать прогон он не
    // должен.
    const textCache = new PushTextCache();

    const skippedNoTz = await this.repo.countPushNoTz();
    const skippedSeen = await this.repo.countPushSeen(at, windowStart, windowEnd);

    let candidates = 0;
    let sent = 0;
    let duplicatePrevented = 0;
    let deferred = 0;
    let failed = 0;
    let blocked = 0;
    let cursor: string | null = null;

    // Порции по 25: JSON карт тяжёлый, и один `SELECT` на всех получателей
    // держал бы соединение всё время рассылки.
    for (;;) {
      const batch: PushRecipient[] = await this.repo.pushRecipients(
        at,
        windowStart,
        windowEnd,
        this.env.PUSH_BATCH_SIZE,
        cursor,
      );

      if (batch.length === 0) {
        break;
      }

      for (const recipient of batch) {
        cursor = recipient.user_id;
        candidates += 1;

        const outcome = await this.pushMorning(recipient, windowEnd, {
          sleep,
          retryDelayMs,
          now,
          textCache,
        });

        if (outcome === 'sent') {
          sent += 1;
        } else if (outcome === 'duplicate') {
          duplicatePrevented += 1;
        } else if (outcome === 'blocked') {
          blocked += 1;
        } else if (outcome === 'deferred') {
          deferred += 1;
        } else {
          failed += 1;
        }

        // ~28 сообщений в секунду суммарно: лимит Bot API — 30.
        await sleep(sendGapMs);

        if (Date.now() - startedAt > PUSH_RUN_BUDGET_MS) {
          this.logger.warn('push_run_budget_exceeded', { candidates, sent });
          break;
        }
      }
    }

    const ms = Date.now() - startedAt;

    await this.repo.insertPushRun({
      candidates,
      sent,
      skippedSeen,
      skippedNoTz,
      duplicatePrevented,
      blocked,
      deferred,
      failed,
      ms,
    });

    this.logger.info('push_run', {
      candidates,
      sent,
      skipped: skippedSeen + skippedNoTz + duplicatePrevented,
      failed: failed + blocked,
      ms,
    });

    return {
      enabled: true,
      candidates,
      sent,
      skippedSeen,
      skippedNoTz,
      duplicatePrevented,
      deferred,
      failed,
      blocked,
      ms,
    };
  }

  /**
   * Один получатель: факты дня → текст → заявка в `push_log` → отправка.
   *
   * Порядок именно такой. Если сначала отправить, а потом писать журнал, два
   * процесса в одну минуту отправят два сообщения и только потом обнаружат
   * конфликт. «Заявка» до отправки делает дубль невозможным: проигравший
   * просто ничего не присылает.
   */
  private async pushMorning(
    recipient: PushRecipient,
    windowEnd: number,
    options: PushTiming,
  ): Promise<'sent' | 'duplicate' | 'blocked' | 'deferred' | 'failed'> {
    const claimed = await this.repo.claimPush(recipient.user_id, recipient.local_date);

    if (!claimed) {
      return 'duplicate';
    }

    const fail = async (error: string): Promise<'failed'> => {
      await this.repo.finishPush(recipient.user_id, recipient.local_date, 'daily_forecast', error);
      return 'failed';
    };

    let text: string;
    let buttons: PushButton[][];

    try {
      const facts = await this.astro.forecastFacts(
        recipient.local_date,
        recipient.tz,
        recipient.data as AstroChartData,
      );
      const message = options.textCache.build(recipient.local_date, {
        sign: facts.moon.sign,
        phase: facts.moon.phase,
      });

      if (message.visibleLength > PUSH_MAX_CHARS) {
        // Такого быть не должно (тест перебирает все 96 комбинаций), но лучше
        // не отправить, чем отправить обрезанное на середине.
        this.logger.error('push_text_too_long', { length: message.visibleLength });
        return fail('text_too_long');
      }

      text = message.text;
      buttons = this.pushButtons();
    } catch (error) {
      this.logger.warn('push_facts_failed', {
        reason: error instanceof Error ? error.name : 'unknown',
      });
      return fail('facts_unavailable');
    }

    const outcome = await this.sendWithPolicy(
      recipient,
      text,
      buttons,
      windowEnd,
      options,
    );

    if (outcome === 'sent') {
      await this.repo.finishPush(recipient.user_id, recipient.local_date, 'daily_forecast', null);
      return 'sent';
    }

    if (outcome === 'blocked' || outcome === 'not_found') {
      // Чат мёртв: снимаем согласие, чтобы за него не платили ошибками каждый
      // день. Включить обратно можно в кабинете — там `POST /me/notifications`.
      await this.repo.disablePush(recipient.user_id);
      await this.events.log({
        userId: recipient.user_id,
        name: 'push_disabled',
        props: { reason: outcome === 'blocked' ? 'blocked' : 'chat_not_found' },
      });
      await this.repo.finishPush(
        recipient.user_id,
        recipient.local_date,
        'daily_forecast',
        outcome === 'blocked' ? 'blocked' : 'chat_not_found',
      );
      return 'blocked';
    }

    if (outcome === 'deferred') {
      await this.repo.finishPush(
        recipient.user_id,
        recipient.local_date,
        'daily_forecast',
        'rate_limited',
      );
      return 'deferred';
    }

    return fail(outcome === 'failed' ? 'telegram_failed' : outcome);
  }

  /**
   * Отправка с политикой повторов.
   *
   * `429` — ждём `retry_after` и **продолжаем с того же человека**: пропустить
   * его и вернуться позже значило бы потерять место в очереди. Прочие ошибки —
   * одна повторная попытка через `retryDelayMs`, и только если окно ещё не
   * закрылось: пуш, который придёт в 08:06, уже не «утренний».
   */
  private async sendWithPolicy(
    recipient: PushRecipient,
    text: string,
    buttons: PushButton[][],
    windowEnd: number,
    options: PushTiming,
  ): Promise<'sent' | 'blocked' | 'not_found' | 'deferred' | 'failed'> {
    let throttleWaits = 0;
    let retries = 0;

    for (;;) {
      const result = await this.telegram.sendPush(Number(recipient.telegram_id), text, { buttons });

      if (result.status === 'sent') {
        return 'sent';
      }

      if (result.status === 'blocked' || result.status === 'not_found') {
        return result.status;
      }

      if (result.status === 'rate_limited') {
        throttleWaits += 1;
        this.logger.warn('push_throttled', {
          retry_after: result.retryAfterSeconds,
          attempt: throttleWaits,
        });

        if (
          throttleWaits > PUSH_MAX_THROTTLE_WAITS ||
          this.windowClosed(recipient.tz, windowEnd, options.now())
        ) {
          return 'deferred';
        }

        await options.sleep((result.retryAfterSeconds ?? 1) * 1_000);
        continue;
      }

      retries += 1;

      if (retries > PUSH_RETRIES || this.windowClosed(recipient.tz, windowEnd, options.now())) {
        return 'failed';
      }

      this.logger.warn('push_retry', {
        attempt: retries,
        error: result.error === null ? null : 'telegram_failed',
      });
      await options.sleep(options.retryDelayMs);
    }
  }

  /**
   * Окно закрылось — «повторять» нечего.
   *
   * Считаем по реальным часам, а не по `at`: повтор идёт через минуту, и за это
   * время местное время получателя могло выйти из окна.
   */
  private windowClosed(timeZone: string, windowEnd: number, at: Date): boolean {
    const local = localParts(at, timeZone);
    return local === null || local.minutesOfDay > windowEnd;
  }

  /**
   * Кнопки пуша: «Открыть разбор дня» (мини-апп на экране «Сегодня») и
   * «Отключить» (`callback_data: push_off`).
   *
   * Вторая кнопка — не ссылка на кабинет: человек читает пуш на экране
   * блокировки, и «зайди в настройки» — это три тапа. Отказ должен стоить
   * одного нажатия, а сообщать о нём будет всплывающая подсказка, не новое
   * сообщение в чате.
   */
  private pushButtons(): PushButton[][] {
    const url = this.openUrl();
    const off: PushButton = { text: PUSH_OFF_TEXT, callbackData: PUSH_OFF_CALLBACK };

    return url === null
      ? [[off]]
      : [[{ text: PUSH_OPEN_TEXT, webAppUrl: url }], [off]];
  }

  /** Адрес мини-аппа без параметра карты: кнопка ведёт на «Сегодня». */
  private openUrl(): string | null {
    return buildTodayUrl(this.env.MINI_APP_URL);
  }

  /** Сколько стоит удержание за месяц — для логов и метрик. */
  async monthCostRub(): Promise<number> {
    return this.repo.monthEngagementCostRub();
  }
}
