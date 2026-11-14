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
import { ReportsService, type ReportView } from './reports.service';

/**
 * `POST /reports` — 202 и `report_id`; `GET /reports/{report_id}` — прогресс,
 * главы по мере готовности и `teaser` до оплаты (контракт 1.5.1).
 *
 * Ошибки: 402 без оплаты, 422 без `Idempotency-Key`, 404 на чужой разбор.
 */
@Controller('reports')
export class ReportsController {
  constructor(@Inject(ReportsService) private readonly reports: ReportsService) {}

  @Post()
  @HttpCode(202)
  async order(
    @CurrentUser() auth: VerifiedInitData,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
  ): Promise<ReportView> {
    return this.reports.order(auth, idempotencyKey, body);
  }

  @Get(':reportId')
  async get(
    @CurrentUser() auth: VerifiedInitData,
    @Param('reportId', new ParseUUIDPipe()) reportId: string,
  ): Promise<ReportView> {
    return this.reports.get(auth, reportId);
  }
}
