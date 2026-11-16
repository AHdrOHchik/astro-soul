import { afterEach, describe, expect, it, vi } from 'vitest';
import { GeoService } from '../src/modules/geo/geo.service';
import { MemoryGeoCache } from '../src/modules/geo/geo.cache';
import { NominatimThrottle } from '../src/modules/geo/nominatim.throttle';
import { JsonLogger } from '../src/common/logger';
import { loadEnv, type AppEnv } from '../src/config/env';
import type { CityRecord } from '@astro-soul/shared';

/**
 * Фолбэк Nominatim (`geo.md`, итерация 20).
 *
 * Ключевые требования, которые здесь и держатся:
 *   • наружу уходит **только строка поиска** — ни координат, ни времени, ни
 *     идентификаторов;
 *   • при `GEO_PROVIDER=bundled` внешних запросов ноль;
 *   • пояс берётся у ближайшего города справочника не дальше 300 км, иначе
 *     города нет (`503 GEO_NOT_FOUND`, `details.reason = no_timezone`);
 *   • кэш на 24 часа: два одинаковых запроса — один внешний вызов;
 *   • `429` не повторяем сразу.
 */

const CONTACT = 'support@example.com';

/** Адрес из первого аргумента `fetch`: строка, `URL` или `Request`. */
function urlOf(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function makeEnv(overrides: Partial<AppEnv> = {}): AppEnv {
  return {
    ...loadEnv(),
    GEO_PROVIDER: 'nominatim',
    GEO_CONTACT_EMAIL: CONTACT,
    GEO_NOMINATIM_URL: 'https://nominatim.test',
    GEO_NOMINATIM_MIN_INTERVAL_MS: 0,
    GEO_NOMINATIM_TIMEOUT_MS: 500,
    GEO_TZ_MAX_DISTANCE_KM: 300,
    GEO_MIN_LOCAL_CANDIDATES: 3,
    ...overrides,
  };
}

/** Ответ Nominatim: jsonv2 без пояса (как в реальности). */
function nominatimResponse(places: unknown[]): Response {
  return new Response(JSON.stringify(places), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

const NEAR_MOSCOW = {
  lat: '55.76',
  lon: '37.62',
  address: { city: 'Химки', country_code: 'ru', state: 'Московская область' },
  namedetails: { name: 'Химки' },
};

const OCEAN = {
  lat: '0',
  lon: '-140',
  address: { city: 'Нигде', country_code: 'us' },
  namedetails: { name: 'Нигде' },
};

function serviceWith(options: {
  readonly env?: Partial<AppEnv>;
  readonly fetchImpl?: typeof fetch;
  readonly cache?: MemoryGeoCache;
  readonly cities?: readonly CityRecord[];
}): { service: GeoService; cache: MemoryGeoCache } {
  const cache = options.cache ?? new MemoryGeoCache();
  const service = new GeoService(
    makeEnv(options.env),
    new JsonLogger('error'),
    cache,
    {
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
      ...(options.cities === undefined ? {} : { cities: options.cities }),
    },
  );
  return { service, cache };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('фолбэк Nominatim включается только по промаху', () => {
  it('GEO_PROVIDER=bundled: внешних запросов ноль даже при пустом справочнике', async () => {
    let calls = 0;
    const fetchImpl = (): Promise<Response> => {
      calls += 1;
      return Promise.resolve(nominatimResponse([NEAR_MOSCOW]));
    };
    const { service } = serviceWith({ env: { GEO_PROVIDER: 'bundled' }, fetchImpl });

    await expect(service.resolve('Атлантида', 5)).resolves.toEqual([]);
    expect(calls).toBe(0);
  });

  it('справочник нашёл три и больше кандидатов — наружу не ходим', async () => {
    let calls = 0;
    const fetchImpl = (): Promise<Response> => {
      calls += 1;
      return Promise.resolve(nominatimResponse([]));
    };
    const { service } = serviceWith({ fetchImpl });

    const places = await service.resolve('Нов', 10);
    expect(places.length).toBeGreaterThanOrEqual(3);
    expect(calls).toBe(0);
  });

  it('нашлось меньше трёх — идём в Nominatim и добавляем свои первыми', async () => {
    const calls: string[] = [];
    const fetchImpl = (input: Parameters<typeof fetch>[0]): Promise<Response> => {
      calls.push(urlOf(input));
      return Promise.resolve(nominatimResponse([NEAR_MOSCOW]));
    };
    const { service } = serviceWith({ fetchImpl });

    const places = await service.resolve('Кимры', 5);
    expect(calls).toHaveLength(1);
    expect(places[0]?.name).toBe('Кимры');
    expect(places.map((place) => place.name)).toContain('Химки');
  });
});

describe('что уходит наружу', () => {
  it('только строка поиска: ни координат, ни времени, ни идентификаторов', async () => {
    let requested: { url: string; headers: Record<string, string> } | null = null;
    const fetchImpl = (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ): Promise<Response> => {
      requested = {
        url: urlOf(input),
        headers: { ...(init?.headers as Record<string, string>) },
      };
      return Promise.resolve(nominatimResponse([NEAR_MOSCOW]));
    };
    const { service } = serviceWith({ fetchImpl });

    await service.resolve('  Атлантида  ', 5);

    const url = new URL(requested!.url);
    expect(url.searchParams.get('q')).toBe('Атлантида');
    // Разрешены только служебные параметры самого Nominatim.
    expect([...url.searchParams.keys()].sort()).toEqual([
      'accept-language',
      'addressdetails',
      'format',
      'limit',
      'q',
    ]);
    // User-Agent — с контактом проекта (требование политики).
    expect(requested!.headers['user-agent']).toContain(CONTACT);
    // В запросе нет ничего, кроме строки поиска и настроек формата.
    expect(JSON.stringify(requested)).not.toMatch(/telegram|chart_id|birth|\d{4}-\d{2}-\d{2}/iu);
  });
});

describe('пояс по координатам', () => {
  it('точка рядом с городом справочника — пояс от ближайшего города', async () => {
    const fetchImpl = (): Promise<Response> => Promise.resolve(nominatimResponse([NEAR_MOSCOW]));
    const { service } = serviceWith({ fetchImpl });

    const [place] = await service.resolve('Атлантида', 5);
    expect(place?.tz).toBe('Europe/Moscow');
  });

  it('явный `timezone` из ответа главнее справочника', async () => {
    const fetchImpl = (): Promise<Response> =>
      Promise.resolve(
        nominatimResponse([{ ...OCEAN, timezone: 'Pacific/Honolulu', address: { city: 'Нигде', country_code: 'us' } }]),
      );
    const { service } = serviceWith({ fetchImpl });

    const [place] = await service.resolve('Атлантида', 5);
    expect(place?.tz).toBe('Pacific/Honolulu');
  });

  it('точка в океане → 503 GEO_NOT_FOUND, reason=no_timezone', async () => {
    const fetchImpl = (): Promise<Response> => Promise.resolve(nominatimResponse([OCEAN]));
    const { service } = serviceWith({ fetchImpl });

    await expect(service.resolve('Атлантида', 5)).rejects.toMatchObject({
      details: { reason: 'no_timezone' },
    });
  });

  it('пояс дальше порога не подставляется: 500 км при пороге 300', async () => {
    // Свой справочник: в настоящем рядом с Химками есть Москва, и «дальше
    // порога» на реальных данных не показать.
    const cities: CityRecord[] = [
      { name: 'Тест-город', country: 'RU', lat: 55.0, lon: 37.0, tz: 'Europe/Moscow' },
    ];
    const far = {
      lat: '59.5',
      lon: '37.0',
      address: { city: 'Далёкий', country_code: 'ru' },
      namedetails: { name: 'Далёкий' },
    };
    const fetchImpl = (): Promise<Response> => Promise.resolve(nominatimResponse([far]));
    const { service } = serviceWith({ cities, fetchImpl });

    await expect(service.resolve('Атлантида', 5)).rejects.toMatchObject({
      details: { reason: 'no_timezone' },
    });
  });
});

describe('кэш и лимиты провайдера', () => {
  it('два одинаковых запроса — один внешний вызов', async () => {
    let calls = 0;
    const fetchImpl = (): Promise<Response> => {
      calls += 1;
      return Promise.resolve(nominatimResponse([NEAR_MOSCOW]));
    };
    const { service } = serviceWith({ fetchImpl });

    await service.resolve('Атлантида', 5);
    await service.resolve('АТЛАНТИДА', 5);
    expect(calls).toBe(1);
  });

  it('разный limit — разные записи кэша', async () => {
    let calls = 0;
    const fetchImpl = (): Promise<Response> => {
      calls += 1;
      return Promise.resolve(nominatimResponse([NEAR_MOSCOW]));
    };
    const { service } = serviceWith({ fetchImpl });

    await service.resolve('Атлантида', 5);
    await service.resolve('Атлантида', 3);
    expect(calls).toBe(2);
  });

  it('429 не повторяем: сразу 503 provider_unavailable', async () => {
    let calls = 0;
    const fetchImpl = (): Promise<Response> => {
      calls += 1;
      return Promise.resolve(new Response('slow down', { status: 429 }));
    };
    const { service } = serviceWith({ fetchImpl });

    await expect(service.resolve('Атлантида', 5)).rejects.toMatchObject({
      details: { reason: 'provider_unavailable' },
    });
    expect(calls).toBe(1);
  });

  it('нет контакта для User-Agent → not_configured, без сетевого вызова', async () => {
    let calls = 0;
    const fetchImpl = (): Promise<Response> => {
      calls += 1;
      return Promise.resolve(nominatimResponse([NEAR_MOSCOW]));
    };
    const { service } = serviceWith({
      env: { GEO_CONTACT_EMAIL: undefined },
      fetchImpl,
    });

    await expect(service.resolve('Атлантида', 5)).rejects.toMatchObject({
      details: { reason: 'not_configured' },
    });
    expect(calls).toBe(0);
  });
});

describe('NominatimThrottle: не больше одного запроса в секунду', () => {
  it('второй вызов ждёт интервал, третий — ещё один', async () => {
    let clock = 0;
    const sleeps: number[] = [];
    const throttle = new NominatimThrottle(
      1_000,
      () => clock,
      (ms) => {
        sleeps.push(ms);
        clock += ms;
        return Promise.resolve();
      },
    );

    await throttle.run(() => Promise.resolve('первый'));
    await throttle.run(() => Promise.resolve('второй'));
    await throttle.run(() => Promise.resolve('третий'));

    expect(sleeps).toEqual([1_000, 1_000]);
  });

  it('ошибка одного вызова не ломает очередь', async () => {
    const throttle = new NominatimThrottle(0);
    await expect(throttle.run(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    await expect(throttle.run(() => Promise.resolve('ok'))).resolves.toBe('ok');
  });
});
