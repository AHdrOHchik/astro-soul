import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { URL } from 'node:url';
import { APP_ENV } from '../../config/env.module';
import type { AppEnv } from '../../config/env';
import { JsonLogger } from '../../common/logger';

export type LlmRole = 'system' | 'user' | 'assistant';

export interface LlmMessage {
  readonly role: LlmRole;
  readonly content: string;
}

export interface LlmRequest {
  readonly messages: readonly LlmMessage[];
  readonly temperature?: number;
  readonly maxTokens?: number;
}

export interface LlmUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
  /** Стоимость вызова в рублях: цена за 1000 токенов задаётся окружением. */
  readonly costRub: number;
}

export interface LlmResponse {
  readonly content: string;
  readonly usage: LlmUsage;
  readonly model: string;
}

export interface LlmProvider {
  readonly name: string;
  complete(request: LlmRequest): Promise<LlmResponse>;
}

/** Ошибка провайдера: `status` есть, когда ответил HTTP. */
export class LlmError extends Error {
  constructor(
    readonly code: 'auth' | 'rate_limited' | 'timeout' | 'tls' | 'provider' | 'config',
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'LlmError';
  }
}

interface HttpResponse {
  readonly status: number;
  readonly body: string;
}

interface TokenCache {
  readonly token: string;
  /** `expires_at` GigaChat приходит в миллисекундах. */
  readonly expiresAtMs: number;
}

const TOKEN_SAFETY_MS = 60_000;
const RETRY_PAUSE_MS = 500;

/**
 * GigaChat 3 Ultra.
 *
 * Три вещи, на которых легко ошибиться и которые здесь учтены:
 *
 *   1. **Токен живёт 30 минут.** OAuth-вызов делается не на каждый запрос, а
 *      один раз: токен кэшируется и обновляется за 60 секунд до истечения.
 *      Две параллельные генерации ждут один и тот же inflight-promise, а не
 *      устраивают две авторизации.
 *   2. **`RqUID` обязателен** в OAuth: без него Сбер отвечает отказом.
 *      Тело — form-urlencoded (`scope=…`), JSON не принимается.
 *   3. **CA-бандл НУЦ Минцифры.** TLS-проверка не отключается никогда:
 *      нет файла — сервис не идёт в сеть и пишет, что именно проверить.
 */
@Injectable()
export class GigaChatClient implements LlmProvider {
  readonly name: string;
  private cache: TokenCache | null = null;
  private inflight: Promise<TokenCache> | null = null;
  private caBundle: Buffer | null = null;

  constructor(
    @Inject(APP_ENV) private readonly env: AppEnv,
    @Inject(JsonLogger) private readonly logger: JsonLogger,
  ) {
    this.name = env.LLM_MODEL;
  }

  /** Разбор идёт без сети, когда ключей нет: это честный флаг, а не тишина. */
  static isConfigured(env: AppEnv): boolean {
    return env.GIGACHAT_AUTH_KEY !== undefined && env.GIGACHAT_SCOPE !== undefined;
  }

  async complete(input: LlmRequest): Promise<LlmResponse> {
    const body = JSON.stringify({
      model: this.env.LLM_MODEL,
      messages: input.messages,
      temperature: input.temperature ?? this.env.LLM_TEMPERATURE,
      max_tokens: input.maxTokens ?? this.env.LLM_MAX_TOKENS,
    });

    const call = async (): Promise<LlmResponse> => {
      const token = await this.accessToken();
      const response = await this.send(`${this.env.GIGACHAT_BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body,
      });

      if (response.status === 401) {
        // Токен отозван или истёк раньше срока: сбрасываем кэш и пробуем один раз.
        this.cache = null;
        throw new LlmError('auth', 'gigachat: 401', 401);
      }
      if (response.status === 429) {
        throw new LlmError('rate_limited', 'gigachat: 429', 429);
      }
      if (response.status < 200 || response.status >= 300) {
        throw new LlmError('provider', `gigachat: ${response.status}`, response.status);
      }

      return this.parseCompletion(response.body);
    };

    return this.withRetry(call);
  }

  /** Один повтор на 429/таймаут и на 401 (после сброса кэша). */
  private async withRetry(call: () => Promise<LlmResponse>): Promise<LlmResponse> {
    try {
      return await call();
    } catch (error) {
      const retryable =
        error instanceof LlmError &&
        (error.code === 'rate_limited' || error.code === 'timeout' || error.code === 'auth');

      this.logger.warn('llm_call_failed', {
        code: error instanceof LlmError ? error.code : 'unknown',
        status: error instanceof LlmError ? error.status : undefined,
        retry: retryable,
      });

      if (!retryable) {
        throw error;
      }

      await new Promise((resolve) => setTimeout(resolve, RETRY_PAUSE_MS));
      return call();
    }
  }

  private parseCompletion(raw: string): LlmResponse {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new LlmError('provider', 'gigachat: ответ не JSON');
    }

    const body = parsed as {
      choices?: { message?: { content?: unknown } }[];
      usage?: { prompt_tokens?: unknown; completion_tokens?: unknown; total_tokens?: unknown };
      model?: unknown;
    };

    const content = body.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || content.trim() === '') {
      throw new LlmError('provider', 'gigachat: пустой choices[0].message.content');
    }

    const promptTokens = Number(body.usage?.prompt_tokens ?? 0);
    const completionTokens = Number(body.usage?.completion_tokens ?? 0);
    const totalTokens = Number(body.usage?.total_tokens ?? promptTokens + completionTokens);

    return {
      content,
      model: typeof body.model === 'string' ? body.model : this.env.LLM_MODEL,
      usage: {
        promptTokens,
        completionTokens,
        totalTokens,
        // Цена за 1000 токенов одна на вход и выход (блок владельца).
        costRub: Math.round(((totalTokens / 1000) * this.env.LLM_PRICE_PER_1K_RUB + Number.EPSILON) * 10_000) / 10_000,
      },
    };
  }

  /** Токен: кэш → inflight → новый OAuth-вызов. */
  private async accessToken(): Promise<string> {
    const now = Date.now();
    if (this.cache !== null && this.cache.expiresAtMs - TOKEN_SAFETY_MS > now) {
      return this.cache.token;
    }

    this.inflight ??= this.fetchToken().finally(() => {
      this.inflight = null;
    });

    const fresh = await this.inflight;
    this.cache = fresh;
    return fresh.token;
  }

  private async fetchToken(): Promise<TokenCache> {
    const key = this.env.GIGACHAT_AUTH_KEY;
    const scope = this.env.GIGACHAT_SCOPE;

    if (key === undefined || scope === undefined) {
      throw new LlmError('config', 'gigachat: нет GIGACHAT_AUTH_KEY или GIGACHAT_SCOPE');
    }

    const response = await this.send(this.env.GIGACHAT_OAUTH_URL, {
      method: 'POST',
      headers: {
        // Basic-ключ из личного кабинета; в логах его нет.
        authorization: `Basic ${key}`,
        // Обязателен на каждый запрос авторизации.
        rquid: randomUUID(),
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      // Form-urlencoded, не JSON: на JSON Сбер отвечает отказом.
      body: new URLSearchParams({ scope }).toString(),
    });

    if (response.status === 401 || response.status === 403) {
      throw new LlmError('auth', 'gigachat oauth: отказ авторизации', response.status);
    }
    if (response.status < 200 || response.status >= 300) {
      throw new LlmError('provider', `gigachat oauth: ${response.status}`, response.status);
    }

    const parsed = JSON.parse(response.body) as { access_token?: unknown; expires_at?: unknown };
    const token = parsed.access_token;
    const expiresAt = Number(parsed.expires_at);

    if (typeof token !== 'string' || !Number.isFinite(expiresAt)) {
      throw new LlmError('provider', 'gigachat oauth: нет access_token или expires_at');
    }

    this.logger.info('llm_token_refreshed', {
      // Только срок жизни: сам токен в лог не попадает.
      expires_in_ms: Math.max(0, expiresAt - Date.now()),
    });

    return { token, expiresAtMs: expiresAt };
  }

  /** HTTP с CA-бандлом: `rejectUnauthorized` не выключается никогда. */
  private async send(
    url: string,
    options: {
      readonly method: 'POST';
      readonly headers: Readonly<Record<string, string>>;
      readonly body: string;
    },
  ): Promise<HttpResponse> {
    const target = new URL(url);
    const isHttps = target.protocol === 'https:';
    const ca = isHttps ? this.ca() : null;

    return new Promise<HttpResponse>((resolve, reject) => {
      const send = isHttps ? httpsRequest : httpRequest;
      const request = send(
        target,
        {
          method: options.method,
          headers: { ...options.headers, 'content-length': Buffer.byteLength(options.body) },
          ...(ca === null ? {} : { ca }),
          timeout: this.env.LLM_TIMEOUT_MS,
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => chunks.push(chunk));
          response.on('end', () => {
            resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') });
          });
        },
      );

      request.on('timeout', () => {
        request.destroy(new LlmError('timeout', 'gigachat: таймаут'));
      });
      request.on('error', (error: Error) => {
        reject(this.mapNetworkError(error));
      });
      request.write(options.body);
      request.end();
    });
  }

  private mapNetworkError(error: Error): LlmError {
    if (error instanceof LlmError) {
      return error;
    }
    const message = error.message.toLowerCase();
    if (message.includes('certificate') || message.includes('self signed') || message.includes('ca')) {
      return new LlmError(
        'tls',
        'gigachat: TLS-ошибка — проверь GIGACHAT_CA_BUNDLE (бандл НУЦ Минцифры)',
      );
    }
    return new LlmError('provider', `gigachat: сеть — ${error.message}`);
  }

  private ca(): Buffer {
    if (this.caBundle !== null) {
      return this.caBundle;
    }

    const path = this.env.GIGACHAT_CA_BUNDLE;
    if (path === undefined) {
      throw new LlmError('config', 'gigachat: не задан GIGACHAT_CA_BUNDLE');
    }

    try {
      this.caBundle = readFileSync(path);
      return this.caBundle;
    } catch {
      // Явное сообщение вместо «не удалось подключиться»: чинится одной строкой.
      throw new LlmError('config', 'gigachat: не читается GIGACHAT_CA_BUNDLE — проверь путь к бандлу');
    }
  }
}
