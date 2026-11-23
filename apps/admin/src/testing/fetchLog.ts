/*
 * Записывающий стаб `fetch` для тестов экранов.
 *
 * Живёт отдельно от `src/api` по двум причинам:
 *   • проверки «панель сделала ровно один POST и не сходила на /admin/metrics»
 *     нужны нескольким файлам, а копировать счётчик вызовов в каждый — способ
 *     разойтись в трактовках;
 *   • запросы здесь пишутся как есть (`url` + `init`), поэтому тест смотрит на
 *     тело и заголовки того самого вызова, а не на «последний запрос» — после
 *     изменения панель перечитывает список, и «последний» это уже GET.
 *
 * Из кода приложения этот файл не импортируется, поэтому в бандл не попадает.
 */

import { vi } from 'vitest';

export interface Call {
  readonly url: string;
  readonly init: RequestInit;
}

export type Responder = (url: string, init: RequestInit) => Response;

export interface FetchLog {
  readonly fetchImpl: typeof fetch;
  readonly calls: Call[];
  /** URL всех запросов — для проверок «куда панель не ходила». */
  readonly urls: () => string[];
  readonly filter: (predicate: (call: Call) => boolean) => Call[];
  /** Ровно один вызов под предикат — иначе тест падает с внятным текстом. */
  readonly only: (predicate: (call: Call) => boolean, what: string) => Call;
}

export function createFetchLog(respond: Responder): FetchLog {
  const calls: Call[] = [];
  const spy = vi.fn((input: string, init: RequestInit = {}) => {
    calls.push({ url: input, init });
    return Promise.resolve(respond(input, init));
  });

  const filter = (predicate: (call: Call) => boolean): Call[] => calls.filter((call) => predicate(call));

  return {
    fetchImpl: spy as unknown as typeof fetch,
    calls,
    urls: () => calls.map((call) => call.url),
    filter,
    only: (predicate, what) => only(filter(predicate), `${what} (всего запросов: ${calls.length})`),
  };
}

/** Ровно один элемент списка: иначе тест падает на «undefined is not a function», а не на «вызовов было два». */
export function only<T>(items: readonly T[], what: string): T {
  const [first] = items;
  if (items.length !== 1 || first === undefined) throw new Error(`${what}: ожидался ровно один вызов, найдено ${items.length}`);
  return first;
}

/** Элемент по индексу с тем же условием — «N-го вызова нет» формулируется прямо. */
export function nth<T>(items: readonly T[], index: number, what: string): T {
  const found = items[index];
  if (found === undefined) throw new Error(`${what}: нет вызова #${index + 1}, всего ${items.length}`);
  return found;
}

/** Тело запроса как объект: `fetch` принимает и Blob, тут это всегда строка JSON. */
export function jsonBody(call: Call): Record<string, unknown> {
  const { body } = call.init;
  if (typeof body !== 'string') throw new Error('тело запроса не строка: тест ищет не то, что отправляет панель');
  return JSON.parse(body) as Record<string, unknown>;
}

/** Заголовок запроса — с приведением, потому что `HeadersInit` бывает массивом. */
export function header(call: Call, name: string): string | undefined {
  const { headers } = call.init;
  if (headers === undefined) return undefined;
  // Панель передаёт обычный объект; `Headers` — на случай, если стаб начнут
  // переиспользовать там, где заголовки собирает вызывающий.
  return headers instanceof Headers ? headers.get(name) ?? undefined : (headers as Record<string, string>)[name];
}

export const jsonResponse = (body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response =>
  new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'Content-Type': 'application/json', ...init.headers },
  });

export const listResponse = (items: readonly unknown[], status = 200): Response => jsonResponse({ items }, { status });

export const problemResponse = (status: number, code: string, message: string, details?: unknown): Response =>
  new Response(JSON.stringify({ code, message, request_id: 'req-test', ...(details === undefined ? {} : { details }) }), {
    status,
    headers: { 'Content-Type': 'application/problem+json' },
  });
