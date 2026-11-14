import { Body, Controller, Get, HttpCode, Inject, Post, Query } from '@nestjs/common';
import type { AskResponse, Forecast } from '@astro-soul/shared';
import { CurrentUser } from '../auth/current-user.decorator';
import type { VerifiedInitData } from '../auth/init-data';
import { EngagementService } from './engagement.service';

/** `/engagement/*`: прогноз читается из кэша, вопрос — единственный LLM-вызов. */
@Controller('engagement')
export class EngagementController {
  constructor(@Inject(EngagementService) private readonly engagement: EngagementService) {}

  @Get('forecast')
  async forecast(
    @CurrentUser() auth: VerifiedInitData,
    @Query('chart_id') chartId: string | undefined,
  ): Promise<Forecast> {
    return this.engagement.getForecast(auth, chartId);
  }

  @Post('ask')
  @HttpCode(200)
  async ask(@CurrentUser() auth: VerifiedInitData, @Body() body: unknown): Promise<AskResponse> {
    return this.engagement.ask(auth, body);
  }
}
