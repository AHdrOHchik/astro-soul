import { Inject, Injectable } from '@nestjs/common';
import type { VerifiedInitData } from '../auth/init-data';
import { APP_ENV } from '../../config/env.module';
import type { AppEnv } from '../../config/env';
import { ApiError, conflict, notFound, validationFailed } from '../../common/api-error';
import { JsonLogger } from '../../common/logger';
import { AstroClient, type AstroDayFacts } from '../astro/astro.client';
import { ChartsRepository } from '../charts/charts.repository';
import { EntitlementsService } from '../entitlements/entitlements.service';
import { EventsRepository } from '../events/events.repository';
import { LLM_PROVIDER } from '../llm/llm.module';
import type { LlmProvider, LlmResponse } from '../llm/llm.client';
import { localParts } from '../engagement/local-time';
import { UsersRepository } from '../users/users.repository';
import { DailyForecastRepository, type DailyForecastRow } from './daily-forecast.repository';
import {
  FORECAST_DISCLAIMER,
  FORECAST_SECTIONS,
  finalizeForecast,
  forbiddenOf,
  forecastFromBody,
  parseForecastAnswer,
  type ForecastSectionView,
} from './daily-forecast.validators';
import { FORECAST_SYSTEM_PROMPT, forecastPrompt } from './daily-forecast.prompts';

/**
 * «Прогноз дня» (контракт 1.6.6).
 *
 * Три правила, из которых следует всё остальное:
 *
 *   1. **Модель вызывается один раз в сутки на человека.** Не «примерно один
 *      раз»: строка `daily_forecasts` вставляется через
 *      `insert … on conflict do nothing`, поэтому два одновременных запроса
 *      дают один вызов, а второй читает готовый текст.
 *   2. **Факты считает сайдкар, текст — модель.** Если модель упала, прогноза
 *      нет: 503 с причиной. Показывать вчерашний текст или заглушку нельзя —
 *      человек читает это как прогноз на сегодня.
 *   3. **Без подписки — одна детерминированная строка, без модели.**
 *      `access: "facts_only"`, `sections: []`.
 */
export interface ForecastFactsView {
  readonly moon_sign: string;
  readonly moon_phase: string;
  readonly illumination: number;
}

export interface ForecastDayView {
  readonly date: string;
  readonly timezone: string;
  readonly status: 'ready' | 'facts_only';
  readonly access: 'subscription' | 'facts_only';
  readonly sections: readonly ForecastSectionView[];
  readonly chars: number;
  readonly warnings: readonly string[];
  readonly generated_at: string | null;
  readonly facts: ForecastFactsView | null;
  readonly disclaimer: string;
}

/** Куда уходит ожидание чужой генерации и как часто её перепроверяют. */
const WAIT_POLL_MS = 400;

@Injectable()
export class DailyForecastService {
  constructor(
    @Inject(APP_ENV) private readonly env: AppEnv,
    @Inject(UsersRepository) private readonly users: UsersRepository,
    @Inject(ChartsRepository) private readonly charts: ChartsRepository,
    @Inject(DailyForecastRepository) private readonly repo: DailyForecastRepository,
    @Inject(AstroClient) private readonly astro: AstroClient,
    @Inject(LLM_PROVIDER) private readonly llm: LlmProvider,
    @Inject(EntitlementsService) private readonly entitlements: EntitlementsService,
    @Inject(EventsRepository) private readonly events: EventsRepository,
    @Inject(JsonLogger) private readonly logger: JsonLogger,
  ) {}

  /**
   * `GET /api/v1/forecast/today`.
   *
   * Дата — всегда местная дата **места рождения**: часовой пояс берётся из
   * профиля (`profiles.place_tz`). Ограничение честно написано в описании
   * маршрута и на экране: человек, уехавший в другой город, увидит прогноз по
   * поясу рождения, и это не баг, а отсутствие данных о текущем месте.
   */
  async today(auth: VerifiedInitData): Promise<ForecastDayView> {
    const userId = this.users.userIdFor(auth.telegramUserId);

    const chart = await this.charts.findLatestByUser(userId);
    if (chart === null) {
      throw notFound({
        message: 'Такой карты нет. Построй карту заново',
        reason: 'chart_not_found',
        details: { reason: 'chart_not_found' },
      });
    }

    const timezone = await this.repo.profileTimezone(userId);
    if (timezone === null) {
      throw validationFailed({
        reason: 'profile_required',
        details: { reason: 'profile_required' },
      });
    }

    const now = new Date();
    const local = localParts(now, timezone);
    if (local === null) {
      // Пояс из профиля не разбирается — это дефект данных, а не вина человека.
      throw new ApiError('INTERNAL', 503, { reason: 'timezone_invalid' });
    }
    const date = local.date;

    const facts = await this.factsOf(date, timezone, chart.data);
    const access = await this.accessOf(userId);

    if (access === 'facts_only') {
      if (this.env.FORECAST_FREE_FACTS !== '1') {
        throw new ApiError('FORBIDDEN', 403, {
          reason: 'subscription_required',
          message: 'Прогноз дня входит в подписку',
          details: { reason: 'subscription_required' },
        });
      }

      await this.events.log({ name: 'forecast_facts_only', userId, props: { date } });
      return this.factsOnlyView(facts);
    }

    const row = await this.getOrGenerate(userId, date, timezone, facts);
    return this.readyView(row);
  }

  /** Доступ: подписка (или выключенный гейт), иначе — только факты. */
  private async accessOf(userId: string): Promise<'subscription' | 'facts_only'> {
    if (this.env.FORECAST_REQUIRES_SUBSCRIPTION !== '1') {
      return 'subscription';
    }

    // Доступ решает entitlements, а не поле `plan` в этом сервисе: гейт стоит
    // на «подписка действует», а что именно она даёт — вопрос каталога планов.
    const entitlements = await this.entitlements.getEntitlements(userId);
    return entitlements.isActive ? 'subscription' : 'facts_only';
  }

  /**
   * Бесплатный экран: три факта, которые считает сайдкар.
   *
   * Ни модели, ни строки в `daily_forecasts`: платить не за что, а строку
   * «pending» без генерации потом не отличить от зависшей.
   */
  private factsOnlyView(facts: AstroDayFacts): ForecastDayView {
    return {
      date: facts.date,
      timezone: facts.timezone,
      status: 'facts_only',
      access: 'facts_only',
      sections: [],
      chars: 0,
      warnings: [],
      generated_at: null,
      facts: {
        moon_sign: facts.moon.sign,
        moon_phase: facts.moon.phase,
        illumination: Math.round(facts.moon.illumination * 100) / 100,
      },
      disclaimer: FORECAST_DISCLAIMER,
    };
  }

  private readyView(row: DailyForecastRow): ForecastDayView {
    const parsed = row.body_md === null ? { sections: [], chars: 0 } : forecastFromBody(row.body_md);

    return {
      date: row.local_date,
      timezone: row.timezone,
      status: 'ready',
      access: 'subscription',
      sections: parsed.sections,
      chars: row.chars ?? parsed.chars,
      warnings: row.warnings,
      generated_at: row.created_at.toISOString(),
      facts: null,
      disclaimer: FORECAST_DISCLAIMER,
    };
  }

  /**
   * Один прогноз в сутки — и один вызов модели.
   *
   * Сценарии:
   *   • строки нет → вставляем и генерируем;
   *   • строка `ready` → отдаём (это кэш, метрика `forecast_cache_hits_24h`);
   *   • строка `pending` свежая → ждём чужую генерацию;
   *   • строка `pending` старше `FORECAST_RETRY_SECONDS` → пробуем захватить;
   *   • строка `failed` и прошло меньше `FORECAST_RETRY_SECONDS` → 503 без
   *     вызова модели: иначе падение провайдера превращается в очередь
   *     платных попыток.
   */
  private async getOrGenerate(
    userId: string,
    date: string,
    timezone: string,
    facts: AstroDayFacts,
  ): Promise<DailyForecastRow> {
    const promptVersion = this.env.PROMPT_VERSION_FORECAST;
    const existing = await this.repo.find(userId, date, promptVersion);

    if (existing === null) {
      const claim = await this.repo.claim({
        userId,
        localDate: date,
        timezone,
        engineVersion: this.env.ENGINE_VERSION,
        promptVersion,
        facts,
      });

      if (claim.created) {
        return this.generate(claim.row);
      }

      return this.resolveExisting(claim.row);
    }

    return this.resolveExisting(existing);
  }

  private async resolveExisting(row: DailyForecastRow): Promise<DailyForecastRow> {
    if (row.status === 'ready') {
      await this.events.log({
        name: 'forecast_cache_hit',
        props: { date: row.local_date, prompt_version: row.prompt_version },
      });
      return row;
    }

    const retryMs = this.env.FORECAST_RETRY_SECONDS * 1000;

    if (row.status === 'failed') {
      if (Date.now() - row.updated_at.getTime() < retryMs) {
        throw this.failed('forecast_failed');
      }
      await this.repo.markPending(row.id);
      return this.generate(row);
    }

    // `pending`: либо генерация идёт прямо сейчас, либо повисла на таймауте.
    if (Date.now() - row.updated_at.getTime() >= retryMs) {
      const claimed = await this.repo.claimStale(row.id, this.env.FORECAST_RETRY_SECONDS);
      if (claimed) {
        return this.generate(row);
      }
    }

    return this.waitFor(row);
  }

  /**
   * Ожидание чужой генерации.
   *
   * Между «сгенерируй сам» и «подожди» выбираем ждать: два вызова модели в одну
   * минуту стоят вдвое дороже, а человеку нужен один текст. Ждём не больше
   * таймаута генерации — дольше держать HTTP-запрос бессмысленно.
   */
  private async waitFor(row: DailyForecastRow): Promise<DailyForecastRow> {
    const deadline = Date.now() + this.env.FORECAST_TIMEOUT_MS;

    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, WAIT_POLL_MS));

      const current = await this.repo.findById(row.id);
      if (current === null) {
        throw this.failed('forecast_failed');
      }
      if (current.status === 'ready') {
        await this.events.log({
          name: 'forecast_cache_hit',
          props: { date: current.local_date, prompt_version: current.prompt_version },
        });
        return current;
      }
      if (current.status === 'failed') {
        throw this.failed('forecast_failed');
      }
    }

    throw this.failed('forecast_timeout');
  }

  /**
   * Генерация текста.
   *
   * Порядок проверок выбран так, чтобы деньги тратились последними:
   * брейкер → месячный потолок → вызов → проверка формы → запись.
   */
  private async generate(row: DailyForecastRow): Promise<DailyForecastRow> {
    const breaker = await this.repo.breaker();
    if (breaker.open) {
      throw new ApiError('INTERNAL', 503, {
        reason: 'forecast_breaker_open',
        details: {
          reason: 'forecast_breaker_open',
          retry_after_ms: breaker.retry_after_ms,
        },
      });
    }

    const monthCost = await this.repo.monthCostRub();
    if (monthCost >= this.env.LLM_DAILY_FORECAST_CAP_RUB * 30) {
      // Месячный потолок — не решение владельца из задачи 0, а следствие
      // дневного: 3 ₽ × 30 дней на человека. Считается по факту расходов.
      throw new ApiError('QUOTA_EXCEEDED', 429, {
        reason: 'forecast_month_cap',
        details: { reason: 'forecast_month_cap' },
      });
    }

    const call = this.llm.complete({
      messages: [
        { role: 'system', content: FORECAST_SYSTEM_PROMPT },
        { role: 'user', content: forecastPrompt({ facts: row.facts }) },
      ],
      temperature: 0.6,
      maxTokens: 1_200,
    });

    const response = await this.runWithTimeout(call, row);

    if (response === null) {
      // Таймаут: строка остаётся `pending`, повтор — через
      // `FORECAST_RETRY_SECONDS`. Промис модели не отменяем: если он доедет,
      // текст сохранится и человек получит его со второго захода.
      throw this.failed('forecast_timeout');
    }

    await this.repo.addCost(row.id, response.usage.costRub);
    await this.checkPerForecastCap(row.id, response, row);

    const text = this.textOf(response.content, row);
    await this.repo.markReady(row.id, text.bodyMd, text.chars, text.warnings);

    await this.events.log({
      name: 'forecast_ready',
      props: {
        date: row.local_date,
        chars: text.chars,
        warnings: text.warnings,
        cost_rub: round4(response.usage.costRub),
      },
    });

    const ready = await this.repo.findById(row.id);
    return ready ?? row;
  }

  /**
   * Таймаут генерации.
   *
   * Возвращает `null`, если модель не успела, и **не** отменяет её вызов:
   * результат, пришедший позже, сохраняется через `saveLate`. Иначе таймаут
   * означал бы, что деньги потрачены, а текста нет ни у кого.
   */
  private async runWithTimeout(
    call: Promise<LlmResponse>,
    row: DailyForecastRow,
  ): Promise<LlmResponse | null> {
    // Метка таймаута отдельным объектом, а не `null`: `null` мог бы прийти и
    // от провайдера, и тогда обычный ответ приняли бы за «не успели».
    const timeoutMark = Symbol('timeout');

    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<typeof timeoutMark>((resolve) => {
      timer = setTimeout(() => resolve(timeoutMark), this.env.FORECAST_TIMEOUT_MS);
    });

    try {
      const result = await Promise.race([call, timeout]);

      if (result === timeoutMark) {
        // Досчитываем в фоне: если модель ответит позже — текст сохранится, и
        // повторный запрос (через `FORECAST_RETRY_SECONDS`) отдаст его без
        // нового вызова. Стоимость пишется ровно один раз — здесь, а не в
        // основном пути: иначе за один вызов в счёте было бы две суммы.
        void call.then(
          (response) => this.saveLate(row, response),
          (error: unknown) => this.failLate(row, error),
        );
        return null;
      }

      return result;
    } catch (error) {
      this.logger.warn('forecast_generation_failed', {
        error_code: this.errorCodeOf(error),
        date: row.local_date,
      });
      await this.repo.markFailed(row.id, this.errorCodeOf(error));
      await this.events.log({
        name: 'forecast_failed',
        props: { date: row.local_date, error_code: this.errorCodeOf(error) },
      });
      throw this.failed('forecast_failed');
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  }

  /**
   * Поздний ответ модели после таймаута.
   *
   * Ошибки здесь только логируются: человек уже получил 503, и второй отказ
   * ему ничего не даёт. Успешный текст сохраняется — следующий запрос (после
   * `FORECAST_RETRY_SECONDS`) отдаст его без нового вызова.
   */
  private async saveLate(row: DailyForecastRow, response: LlmResponse): Promise<void> {
    try {
      const current = await this.repo.findById(row.id);
      if (current === null || current.status === 'ready') {
        return;
      }

      await this.repo.addCost(row.id, response.usage.costRub);
      const text = this.textOf(response.content, row);
      await this.repo.markReady(row.id, text.bodyMd, text.chars, text.warnings);
      this.logger.info('forecast_late_saved', { date: row.local_date, chars: text.chars });
    } catch (error) {
      this.logger.warn('forecast_late_failed', {
        error: error instanceof Error ? error.message : 'unknown',
      });
    }
  }

  private async failLate(row: DailyForecastRow, error: unknown): Promise<void> {
    try {
      const current = await this.repo.findById(row.id);
      if (current === null || current.status !== 'pending') {
        return;
      }
      await this.repo.markFailed(row.id, this.errorCodeOf(error));
    } catch {
      // Ничего: строку подберёт следующий запрос по таймауту.
    }
  }

  /**
   * Потолок на один прогноз.
   *
   * Проверяется **после** вызова: отменить расход уже нельзя, но текст дороже
   * потолка показывать не будем — это сигнал, что промпт или модель поменяли
   * цену, и его надо увидеть в метриках, а не в счёте.
   */
  private async checkPerForecastCap(
    id: string,
    response: LlmResponse,
    row: DailyForecastRow,
  ): Promise<void> {
    if (response.usage.costRub <= this.env.LLM_DAILY_FORECAST_CAP_RUB) {
      return;
    }

    this.logger.error('forecast_cap_exceeded', {
      cost_rub: round4(response.usage.costRub),
      cap_rub: this.env.LLM_DAILY_FORECAST_CAP_RUB,
      date: row.local_date,
    });
    await this.repo.markFailed(id, 'forecast_cap_exceeded');
    await this.events.log({
      name: 'forecast_failed',
      props: { date: row.local_date, error_code: 'forecast_cap_exceeded' },
    });
    throw this.failed('forecast_failed');
  }

  /** Разбор ответа модели: форма, запрещённое содержание, обрезка. */
  private textOf(
    raw: string,
    row: DailyForecastRow,
  ): { bodyMd: string; chars: number; warnings: readonly string[] } {
    const parsed = parseForecastAnswer(raw);

    if (parsed === null) {
      this.logger.warn('forecast_unparsable', { date: row.local_date });
      throw this.failed('forecast_bad_format');
    }

    const forbidden = forbiddenOf(Object.values(parsed).join('\n'));
    if (forbidden !== null) {
      this.logger.warn('forecast_forbidden_content', {
        date: row.local_date,
        rule: forbidden,
      });
      throw this.failed('forecast_forbidden_content');
    }

    const text = finalizeForecast(parsed);
    if (text === null) {
      this.logger.warn('forecast_incomplete', { date: row.local_date });
      throw this.failed('forecast_incomplete');
    }

    return { bodyMd: text.bodyMd, chars: text.chars, warnings: text.warnings };
  }

  /** Факты дня из сайдкара. Ошибка сайдкара — 503 с `astro_unavailable`. */
  private async factsOf(
    date: string,
    timezone: string,
    data: Parameters<AstroClient['forecastFacts']>[2],
  ): Promise<AstroDayFacts> {
    try {
      return await this.astro.forecastFacts(date, timezone, data);
    } catch (error) {
      this.logger.error('forecast_facts_failed', {
        date,
        reason: error instanceof Error ? error.message : 'unknown',
      });
      throw this.failed('forecast_failed');
    }
  }

  private failed(code: string): ApiError {
    return new ApiError('INTERNAL', 503, {
      reason: 'forecast_failed',
      details: { reason: 'forecast_failed', code },
    });
  }

  private errorCodeOf(error: unknown): string {
    if (error instanceof ApiError) {
      return error.reason ?? 'forecast_failed';
    }
    if (error instanceof Error) {
      return error.name === 'LlmError' ? 'llm_error' : 'forecast_failed';
    }
    return 'forecast_failed';
  }
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

/** `409` для «вопрос уже в работе» — общий формат с вопросами. */
export function questionInProgress(): ApiError {
  return conflict({ reason: 'question_in_progress' });
}

/** Порядок разделов в ответе — серверный, не из модели. */
export const FORECAST_SECTION_KEYS = FORECAST_SECTIONS.map((section) => section.key);
