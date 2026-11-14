import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppEnv } from '../src/config/env';
import { JsonLogger } from '../src/common/logger';
import { GigaChatClient, LlmError } from '../src/modules/llm/llm.client';
import { loadEnv } from '../src/config/env';
import { applyTestEnv } from './test-env';

/**
 * Тесты провайдера на локальном HTTP-сервере: сеть не нужна, деньги не
 * тратятся, а поведение то же, что у Сбера — OAuth, `expires_at` в мс,
 * 401/429, `usage`.
 */
interface StubState {
  oauthCalls: number;
  chatCalls: number;
  chatStatus: number[];
  tokenTtlMs: number;
  scopeSeen: string[];
  rquidSeen: string[];
  contentTypeSeen: string[];
}

let server: Server;
let base: string;
let state: StubState;

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

function collect(request: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

beforeEach(async () => {
  state = {
    oauthCalls: 0,
    chatCalls: 0,
    chatStatus: [],
    tokenTtlMs: 30 * 60_000,
    scopeSeen: [],
    rquidSeen: [],
    contentTypeSeen: [],
  };

  server = createServer((request, response) => {
    void (async () => {
      const body = await collect(request);

      if (request.url === '/oauth') {
        state.oauthCalls += 1;
        state.scopeSeen.push(body);
        state.rquidSeen.push(String(request.headers['rquid'] ?? ''));
        state.contentTypeSeen.push(String(request.headers['content-type'] ?? ''));
        // expires_at — в миллисекундах, как у GigaChat.
        json(response, 200, {
          access_token: `token-${state.oauthCalls}`,
          expires_at: Date.now() + state.tokenTtlMs,
        });
        return;
      }

      if (request.url === '/chat/completions') {
        state.chatCalls += 1;
        const status = state.chatStatus.length === 0 ? 200 : (state.chatStatus.shift() ?? 200);
        if (status !== 200) {
          json(response, status, { message: 'stub' });
          return;
        }
        json(response, 200, {
          model: 'GigaChat-3-Ultra',
          choices: [{ message: { content: 'Текст главы.' } }],
          usage: { prompt_tokens: 1600, completion_tokens: 400, total_tokens: 2000 },
        });
        return;
      }

      response.writeHead(404);
      response.end();
    })();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function env(overrides: Partial<AppEnv> = {}): AppEnv {
  return {
    GIGACHAT_AUTH_KEY: 'auth-key',
    GIGACHAT_SCOPE: 'GIGACHAT_API_PERS',
    GIGACHAT_OAUTH_URL: `${base}/oauth`,
    GIGACHAT_BASE_URL: base,
    GIGACHAT_CA_BUNDLE: undefined,
    LLM_MODEL: 'GigaChat-3-Ultra',
    LLM_TEMPERATURE: 0.7,
    LLM_MAX_TOKENS: 1400,
    LLM_TIMEOUT_MS: 5_000,
    ...overrides,
  } as AppEnv;
}

function client(overrides: Partial<AppEnv> = {}): GigaChatClient {
  return new GigaChatClient(env(overrides), new JsonLogger('error'));
}

const ask = { messages: [{ role: 'user' as const, content: 'Привет' }] };

describe('GigaChatClient', () => {
  it('кэширует токен: два вызова — одна авторизация', async () => {
    const llm = client();

    await llm.complete(ask);
    await llm.complete(ask);

    expect(state.oauthCalls).toBe(1);
    expect(state.chatCalls).toBe(2);
    // OAuth — form-urlencoded, RqUID на каждый запрос, scope из окружения.
    expect(state.contentTypeSeen).toEqual(['application/x-www-form-urlencoded']);
    expect(state.scopeSeen).toEqual(['scope=GIGACHAT_API_PERS']);
    expect(state.rquidSeen[0]).toMatch(/^[0-9a-f-]{36}$/u);
  });

  it('обновляет токен за 60 секунд до истечения', async () => {
    // Токен живёт 30 минут: второй вызов берёт его из кэша.
    const llm = client();
    await llm.complete(ask);
    await llm.complete(ask);
    expect(state.oauthCalls).toBe(1);

    // Срок жизни меньше страховочного зазора — токен не считается годным.
    state.tokenTtlMs = 30_000;
    state.oauthCalls = 0;
    const shortLived = client();
    await shortLived.complete(ask);
    await shortLived.complete(ask);
    expect(state.oauthCalls).toBe(2);
  });

  it('на 401 сбрасывает токен и делает ровно один повтор', async () => {
    state.chatStatus = [401];
    const llm = client();

    const response = await llm.complete(ask);

    expect(response.content).toBe('Текст главы.');
    expect(state.chatCalls).toBe(2);
    // Токен отозван → авторизуемся заново, а не идём со старым.
    expect(state.oauthCalls).toBe(2);
  });

  it('на 429 повторяет один раз, затем отдаёт rate_limited', async () => {
    state.chatStatus = [429, 429];
    const llm = client();

    await expect(llm.complete(ask)).rejects.toMatchObject({ code: 'rate_limited' });
    expect(state.chatCalls).toBe(2);
  });

  it('считает стоимость по usage: 2000 токенов × 0.5 ₽ / 1000', async () => {
    const llm = client();

    const response = await llm.complete(ask);

    expect(response.usage.totalTokens).toBe(2000);
    expect(response.usage.costRub).toBe(1);
    expect(response.usage.costRub).toBeLessThan(2);
  });

  it('цена следует модели: 2-Max — 0,65 ₽, 3-Ultra — 0,5 ₽ за 1000 токенов', async () => {
    const ultra = await client().complete(ask);
    expect(ultra.usage.costRub).toBe(1);

    const max = await client({ LLM_MODEL: 'GigaChat-2-Max' }).complete(ask);
    expect(max.usage.costRub).toBe(1.3);
  });

  it('неизвестная модель — ошибка конфигурации, а не нулевая цена', () => {
    expect(() => client({ LLM_MODEL: 'GigaChat-9-Unknown' })).toThrow(/нет цены/u);
  });

  it('окружение: scope по умолчанию PERS, лимиты 80 ₽ и 2000 ₽', () => {
    applyTestEnv();
    const source: NodeJS.ProcessEnv = { ...process.env };
    delete source['LLM_REPORT_CAP_RUB'];
    delete source['LLM_MONTHLY_CAP_RUB'];
    delete source['GIGACHAT_SCOPE'];

    const parsed = loadEnv(source);

    expect(parsed.GIGACHAT_SCOPE).toBe('GIGACHAT_API_PERS');
    expect(parsed.LLM_REPORT_CAP_RUB).toBe(80);
    expect(parsed.LLM_MONTHLY_CAP_RUB).toBe(2000);

    // Неизвестная модель ломает старт: цены для неё нет.
    expect(() => loadEnv({ ...source, LLM_MODEL: 'GigaChat-9-Unknown' })).toThrow(/LLM_MODEL/u);
  });

  it('без CA-бандла не идёт в https и просит проверить GIGACHAT_CA_BUNDLE', async () => {
    const llm = client({
      GIGACHAT_OAUTH_URL: 'https://gigachat.example/oauth',
      GIGACHAT_BASE_URL: 'https://gigachat.example/api',
    });

    const error = await llm.complete(ask).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(LlmError);
    expect((error as LlmError).code).toBe('config');
    expect((error as LlmError).message).toContain('GIGACHAT_CA_BUNDLE');
  });
});
