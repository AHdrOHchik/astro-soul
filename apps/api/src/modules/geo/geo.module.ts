import { Inject, Module, type OnModuleDestroy } from '@nestjs/common';
import { APP_ENV } from '../../config/env.module';
import type { AppEnv } from '../../config/env';
import { JsonLogger } from '../../common/logger';
import { GeoController } from './geo.controller';
import { GeoService } from './geo.service';
import { GEO_CACHE, createGeoCache, type GeoCache } from './geo.cache';

/**
 * Кэш геоподсказок создаётся один раз на процесс.
 *
 * Redis подключается, только если задан `REDIS_URL`; иначе — память процесса.
 * Ошибка соединения не мешает старту: поиск продолжает работать без общего
 * кэша (в логе `geo_cache_unavailable`).
 */
@Module({
  controllers: [GeoController],
  providers: [
    {
      provide: GEO_CACHE,
      useFactory: async (env: AppEnv, logger: JsonLogger): Promise<GeoCache> =>
        createGeoCache(env.REDIS_URL, logger, env.GEO_CACHE_TTL_SECONDS),
      inject: [APP_ENV, JsonLogger],
    },
    GeoService,
  ],
  exports: [GeoService],
})
export class GeoModule implements OnModuleDestroy {
  constructor(@Inject(GEO_CACHE) private readonly cache: GeoCache) {}

  /** Redis-соединение закрываем сами: иначе процесс не завершается по SIGTERM. */
  async onModuleDestroy(): Promise<void> {
    await this.cache.close();
  }
}
