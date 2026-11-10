import { Body, Controller, HttpCode, Inject, Post } from '@nestjs/common';
import type { GeoPlace } from '@astro-soul/shared';
import { GeoService } from './geo.service';

interface GeoResolveBody {
  readonly query?: unknown;
  readonly limit?: unknown;
}

/**
 * `POST /geo/resolve` — подсказки городов.
 *
 * Всегда 200 и массив: пустой массив = «города нет». 503 отдаётся только
 * когда недоступен сам провайдер геоданных (контракт 1.2.1).
 */
@Controller('geo')
export class GeoController {
  constructor(@Inject(GeoService) private readonly geo: GeoService) {}

  @Post('resolve')
  @HttpCode(200)
  async resolve(@Body() body: GeoResolveBody | undefined): Promise<GeoPlace[]> {
    return this.geo.resolve(body?.query, body?.limit);
  }
}
