import { createHash } from 'node:crypto';
import type { GeoPlace } from '@astro-soul/shared';
import type { JsonLogger } from '../../common/logger';

/**
 * Кэш ответов Nominatim на 24 часа (`geo.md`).
 *
 * Зачем: подсказки идут по мере ввода, и один и тот же город спрашивают десятки
 * раз. Политика Nominatim — не больше одного запроса в секунду, поэтому кэш не
 * оптимизация, а условие вежливого использования.
 *
 * По умолчанию работает Redis (`REDIS_URL`): кэш общий для инстансов, а после
 * рестарта API не теряется. В песочнице и тестах Redis может отсутствовать —
 * тогда используется память процесса, и это видно в логе `geo_cache_unavailable`.
 */
/** Токен Nest для кэша: тесты подменяют его своим экземпляром. */
export const GEO_CACHE = Symbol('GEO_CACHE');

export interface GeoCache {
  get(key: string): Promise<GeoPlace[] | null>;
  set(key: string, places: readonly GeoPlace[], ttlSeconds: number): Promise<void>;
  close(): Promise<void>;
}

/** Ключ кэша: нормализованная строка запроса и размер ответа. */
export function cacheKey(normalizedQuery: string, limit: number): string {
  const digest = createHash('sha256').update(`${normalizedQuery}|${limit}`).digest('hex');
  return `geo:nominatim:${digest}`;
}

/** Сколько записей держим в памяти: 1 000 строк по 5 городов — с запасом. */
const MEMORY_MAX_ENTRIES = 1_000;

interface MemoryEntry {
  readonly places: readonly GeoPlace[];
  readonly expiresAt: number;
}

export class MemoryGeoCache implements GeoCache {
  private readonly entries = new Map<string, MemoryEntry>();

  get(key: string): Promise<GeoPlace[] | null> {
    const entry = this.entries.get(key);
    if (entry === undefined) {
      return Promise.resolve(null);
    }
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return Promise.resolve(null);
    }
    return Promise.resolve([...entry.places]);
  }

  set(key: string, places: readonly GeoPlace[], ttlSeconds: number): Promise<void> {
    // Простейшая защита от роста: старые записи уходят первыми.
    if (this.entries.size >= MEMORY_MAX_ENTRIES) {
      const oldest = this.entries.keys().next();
      if (!oldest.done) {
        this.entries.delete(oldest.value);
      }
    }
    this.entries.set(key, { places: [...places], expiresAt: Date.now() + ttlSeconds * 1_000 });
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.entries.clear();
    return Promise.resolve();
  }
}

/** Минимальный интерфейс node-redis: нужны три команды и закрытие. */
interface RedisClientLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, options: { EX: number }): Promise<unknown>;
  quit(): Promise<unknown>;
  on(event: 'error', handler: (error: Error) => void): unknown;
}

export class RedisGeoCache implements GeoCache {
  constructor(
    private readonly client: RedisClientLike,
    private readonly logger: JsonLogger,
  ) {
    // Ошибка соединения не должна ронять поиск: она только в лог.
    this.client.on('error', (error: Error) => {
      this.logger.warn('geo_cache_error', { reason: error.message });
    });
  }

  async get(key: string): Promise<GeoPlace[] | null> {
    const raw = await this.client.get(key);
    if (raw === null) {
      return null;
    }
    try {
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed) ? (parsed as GeoPlace[]) : null;
    } catch {
      return null;
    }
  }

  async set(key: string, places: readonly GeoPlace[], ttlSeconds: number): Promise<void> {
    await this.client.set(key, JSON.stringify(places), { EX: ttlSeconds });
  }

  async close(): Promise<void> {
    await this.client.quit();
  }
}

/**
 * Redis, если он настроен и доступен; иначе память процесса.
 *
 * Модуль `redis` подключается динамически: в тестах и на инстансе без
 * `REDIS_URL` он не загружается вовсе.
 */
export async function createGeoCache(
  redisUrl: string | undefined,
  logger: JsonLogger,
  ttlSeconds: number,
): Promise<GeoCache> {
  if (redisUrl === undefined || redisUrl === '') {
    return new MemoryGeoCache();
  }

  try {
    const moduleName = 'redis';
    const redis = (await import(moduleName)) as unknown as {
      createClient(options: { url: string }): RedisClientLike & { connect(): Promise<void> };
    };
    const client = redis.createClient({ url: redisUrl });
    // Соединение с таймаутом: без Redis API обязан подняться.
    await Promise.race([
      client.connect(),
      new Promise<never>((_, reject) => {
        const timer = setTimeout(() => reject(new Error('redis_connect_timeout')), 1_000);
        timer.unref();
      }),
    ]);
    logger.info('geo_cache_ready', { backend: 'redis', ttl_seconds: ttlSeconds });
    return new RedisGeoCache(client, logger);
  } catch (error) {
    logger.warn('geo_cache_unavailable', {
      backend: 'redis',
      reason: error instanceof Error ? error.message : 'unknown',
    });
    return new MemoryGeoCache();
  }
}
