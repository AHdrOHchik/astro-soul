import { lookup } from 'node:dns/promises';

/**
 * «Дозванивается ли Telegram до нашего адреса» — проверка до похода в Bot API
 * (итерация 26).
 *
 * Зачем отдельно от `setWebhook`: облачный туннель (`cloudflared tunnel --url
 * …`) выдаёт **новый** адрес при каждом запуске, и старый перестаёт
 * резолвиться. `setWebhook` на нерезолвящийся адрес Telegram принимает молча —
 * Bot API не проверяет чужой DNS, — а потом не может доставить
 * `pre_checkout_query`: человек жмёт «оплатить», и ничего не происходит. В
 * логах при этом ни одной ошибки: `setWebhook` вернул `ok: true`.
 *
 * Поэтому резолвим хост `MINI_APP_URL` сами, до вызова Bot API, и называем
 * причину вслух: что не так, что из этого следует и что делать.
 */

/** Сколько ждём DNS: дольше — это уже «сеть лежит», а API должен стартовать. */
export const DEFAULT_RESOLVE_TIMEOUT_MS = 2000;

export interface HostResolution {
  readonly host: string | null;
  /** Хост резолвится в адрес — значит Telegram сможет постучаться. */
  readonly resolvable: boolean;
  readonly addresses: readonly string[];
  readonly error: string | null;
}

/** Хост из абсолютного URL; `null`, если URL пустой или не разбирается. */
export function hostFromUrl(url: string | null | undefined): string | null {
  if (url === null || url === undefined || url === '') {
    return null;
  }

  try {
    const { hostname } = new URL(url);
    return hostname === '' ? null : hostname;
  } catch {
    return null;
  }
}

/**
 * Резолв хоста с жёстким таймаутом.
 *
 * Никогда не бросает: недоступный DNS — это `resolvable: false` с текстом
 * ошибки, а не падение старта API. IP-адрес в `MINI_APP_URL` резолвить не надо —
 * считаем резолвящимся (так стенд может работать без DNS вовсе).
 */
export async function resolveHost(
  host: string | null,
  timeoutMs: number = DEFAULT_RESOLVE_TIMEOUT_MS,
): Promise<HostResolution> {
  if (host === null) {
    return { host: null, resolvable: false, addresses: [], error: 'хост не задан' };
  }

  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':')) {
    return { host, resolvable: true, addresses: [host], error: null };
  }

  let timer: NodeJS.Timeout | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`DNS не ответил за ${String(timeoutMs)} мс`));
      }, timeoutMs);
    });

    const result = await Promise.race([lookup(host, { all: true }), timeout]);
    const addresses = result.map((entry) => entry.address);

    if (addresses.length === 0) {
      return { host, resolvable: false, addresses, error: 'DNS вернул пустой ответ' };
    }

    return { host, resolvable: true, addresses, error: null };
  } catch (error) {
    return {
      host,
      resolvable: false,
      addresses: [],
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

/**
 * Человеческий текст для владельца: причина, следствие, действие.
 *
 * Требование итерации 26 дословно: WARN должен называть виновника
 * (`MINI_APP_URL` не резолвится) и лечение (поднять туннель, перезапустить
 * API), а не ограничиваться кодом ошибки.
 */
export function webhookUnreachableHint(resolution: HostResolution): string {
  const host = resolution.host ?? '(хост не задан)';
  const reason = resolution.error ?? 'DNS не вернул адрес';

  return (
    `адрес MINI_APP_URL (${host}) не резолвится: ${reason}. ` +
    'Telegram не сможет доставить pre_checkout_query — оплата в Telegram работать не будет. ' +
    'Запусти туннель (например, cloudflared tunnel --url http://localhost:3000), ' +
    'проверь MINI_APP_URL и перезапусти API: pnpm payments:diagnose --set-webhook'
  );
}
