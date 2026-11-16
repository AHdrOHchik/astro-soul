import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator';
import type { VerifiedInitData } from '../auth/init-data';
import {
  CompatService,
  type CompatibilityAccepted,
  type CompatibilityListView,
  type CompatibilityView,
} from './compat.service';

/**
 * Совместимость (контракт 1.6.0).
 *
 *   POST /compatibility      — 202 `{compatibility_id, status: "pending"}`
 *   GET  /compatibility/{id} — разделы, пометки, `created_at`
 *   GET  /compatibility      — история и остаток квоты
 *
 * Ошибки: 402 без права, 422 `compat_quota_exhausted` / `compat_already_owned`,
 * 503 `compat_breaker_open` (свой брейкер, не общий с разбором), 404 на чужой
 * заказ.
 */
@Controller('compatibility')
export class CompatController {
  constructor(@Inject(CompatService) private readonly compat: CompatService) {}

  @Post()
  @HttpCode(202)
  async order(
    @CurrentUser() auth: VerifiedInitData,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
  ): Promise<CompatibilityAccepted> {
    return this.compat.order(auth, idempotencyKey, body);
  }

  /**
   * Список стоит **до** `:compatibilityId`: иначе NestJS разберёт `/compatibility`
   * как пустой параметр и ответит 404 вместо истории.
   */
  @Get()
  async list(@CurrentUser() auth: VerifiedInitData): Promise<CompatibilityListView> {
    return this.compat.list(auth);
  }

  @Get(':compatibilityId')
  async get(
    @CurrentUser() auth: VerifiedInitData,
    @Param('compatibilityId', new ParseUUIDPipe()) compatibilityId: string,
  ): Promise<CompatibilityView> {
    return this.compat.get(auth, compatibilityId);
  }
}
