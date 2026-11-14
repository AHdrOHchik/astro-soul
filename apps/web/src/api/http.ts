import { ApiError, errorFromResponse } from './errors';

export const INIT_DATA_HEADER = 'X-Telegram-Init-Data';
/** On every answer of the API: the id support finds the request by. */
export const REQUEST_ID_HEADER = 'X-Request-Id';

export interface HttpClientOptions {
  /** API origin without a trailing slash; '' = same origin. */
  baseUrl: string;
  /** Raw `Telegram.WebApp.initData`. Read on every request, never stored by the client. */
  getInitData: () => string;
  /** Budget for the whole call, retries included. */
  timeoutMs?: number;
  /** Extra attempts after a 5xx answer. Nothing else is ever retried. */
  retries?: number;
  retryDelayMs?: (attempt: number) => number;
  fetch?: typeof fetch;
}

export interface RequestOptions {
  body?: unknown;
  headers?: Record<string, string>;
  /** Lets the caller cancel; the promise then rejects with the original AbortError. */
  signal?: AbortSignal;
  /** Pass false for calls that are not safe to repeat. */
  retry?: boolean;
  /** Lets the browser finish the call after the page is gone. For the last words of a page that is being closed. */
  keepalive?: boolean;
}

export type HttpMethod = 'GET' | 'POST' | 'DELETE';
export type HttpRequest = <T>(method: HttpMethod, path: string, options?: RequestOptions) => Promise<T>;

export const DEFAULT_TIMEOUT_MS = 15_000;
export const DEFAULT_RETRIES = 2;
const defaultRetryDelay = (attempt: number) => 300 * 3 ** attempt;

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort);
    if (signal.aborted) onAbort();
  });
}

async function readBody<T>(response: Response): Promise<T> {
  const text = response.status === 204 ? '' : await response.text();
  let body: unknown;
  let readable = true;
  try {
    body = text === '' ? undefined : JSON.parse(text);
  } catch {
    readable = false;
  }
  if (!response.ok) throw errorFromResponse(response.status, body, response.headers.get(REQUEST_ID_HEADER));
  if (!readable) throw new ApiError('INVALID_RESPONSE', { status: response.status });
  return body as T;
}

export function createHttpClient(options: HttpClientOptions): HttpRequest {
  const {
    baseUrl,
    getInitData,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    retries = DEFAULT_RETRIES,
    retryDelayMs = defaultRetryDelay,
  } = options;
  const doFetch: typeof fetch = options.fetch ?? ((input, init) => fetch(input, init));

  return async function request<T>(method: HttpMethod, path: string, requestOptions: RequestOptions = {}): Promise<T> {
    const { body, headers, signal, retry = true, keepalive } = requestOptions;
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const controller = new AbortController();
    // `signal.reason` would tell a timeout from a caller's cancel, but Safari 15.0–15.3 lacks it.
    const deadline = { passed: false };
    const timer = setTimeout(() => {
      deadline.passed = true;
      controller.abort();
    }, timeoutMs);
    const cancel = () => {
      controller.abort();
    };
    signal?.addEventListener('abort', cancel);

    try {
      const initData = getInitData();
      const init: RequestInit = {
        method,
        headers: {
          Accept: 'application/json, application/problem+json',
          ...(initData !== '' && { [INIT_DATA_HEADER]: initData }),
          ...(body !== undefined && { 'Content-Type': 'application/json' }),
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
        ...(keepalive && { keepalive: true }),
      };

      for (let attempt = 0; ; attempt += 1) {
        const response = await doFetch(baseUrl + path, init);
        if (response.status >= 500 && retry && attempt < retries) {
          // Release the connection; the failed body is of no use.
          response.body?.cancel().catch(() => undefined);
          await sleep(retryDelayMs(attempt), controller.signal);
          continue;
        }
        return await readBody<T>(response);
      }
    } catch (cause) {
      if (cause instanceof ApiError) throw cause;
      if (deadline.passed) throw new ApiError('TIMEOUT');
      if (controller.signal.aborted) throw cause;
      throw new ApiError('NETWORK');
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
    }
  };
}
