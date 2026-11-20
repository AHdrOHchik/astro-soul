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
  Query,
} from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator';
import type { VerifiedInitData } from '../auth/init-data';
import {
  QuestionsService,
  type QuestionAccepted,
  type QuestionList,
  type QuestionView,
} from './questions.service';

/**
 * «Спроси карту» (контракт 1.6.6).
 *
 * `POST` **всегда** отвечает `202`: ответ готовится в фоне, и синхронный
 * ответ означал бы 25-секундное соединение на каждый вопрос. Исключение —
 * детерминированный отказ по теме: строки уже создана как `refused`, и
 * `status` в ответе это показывает.
 */
@Controller('questions')
export class QuestionsController {
  constructor(@Inject(QuestionsService) private readonly questions: QuestionsService) {}

  @Post()
  @HttpCode(202)
  async ask(
    @CurrentUser() auth: VerifiedInitData,
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ): Promise<QuestionAccepted> {
    return this.questions.ask(auth, body, idempotencyKey);
  }

  @Get()
  async list(
    @CurrentUser() auth: VerifiedInitData,
    @Query('limit') limit: string | undefined,
  ): Promise<QuestionList> {
    return this.questions.list(auth, limit);
  }

  @Get(':id')
  async get(
    @CurrentUser() auth: VerifiedInitData,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<QuestionView> {
    return this.questions.get(auth, id);
  }
}
