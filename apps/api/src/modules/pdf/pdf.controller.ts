import {
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
import { PdfService, type PdfStatusView } from './pdf.service';

/**
 * PDF разбора (контракт 1.6.8).
 *
 * `POST` — `202` в любом случае: сборка идёт в фоне, готовый файл отдаётся
 * сразу (`status: "ready"` + ссылка). `GET` — статус и **свежая** подписанная
 * ссылка (старая протухает, это нормально).
 *
 * Ошибки: `403 report_not_paid` — чужой или неоплаченный разбор,
 * `404 report_not_found`, `409 report_not_ready`.
 */
@Controller('reports/:reportId/pdf')
export class PdfController {
  constructor(@Inject(PdfService) private readonly pdf: PdfService) {}

  @Post()
  @HttpCode(202)
  async request(
    @CurrentUser() auth: VerifiedInitData,
    @Param('reportId', new ParseUUIDPipe()) reportId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ): Promise<PdfStatusView> {
    return this.pdf.request(auth, reportId, idempotencyKey);
  }

  @Get()
  async status(
    @CurrentUser() auth: VerifiedInitData,
    @Param('reportId', new ParseUUIDPipe()) reportId: string,
  ): Promise<PdfStatusView> {
    return this.pdf.status(auth, reportId);
  }
}
