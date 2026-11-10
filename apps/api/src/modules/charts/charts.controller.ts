import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import type { Chart, ChartCreatedResponse } from '@astro-soul/shared';
import { CurrentUser } from '../auth/current-user.decorator';
import type { VerifiedInitData } from '../auth/init-data';
import { ChartsService } from './charts.service';

@Controller('charts')
export class ChartsController {
  constructor(@Inject(ChartsService) private readonly charts: ChartsService) {}

  @Post()
  @HttpCode(201)
  async create(
    @CurrentUser() auth: VerifiedInitData,
    @Body() body: unknown,
  ): Promise<ChartCreatedResponse> {
    return this.charts.create(auth, body);
  }

  @Get(':chartId')
  async getById(
    @CurrentUser() auth: VerifiedInitData,
    @Param('chartId', new ParseUUIDPipe()) chartId: string,
  ): Promise<Chart> {
    return this.charts.getById(auth, chartId);
  }

  /**
   * Публичный маршрут (`security: []` в контракте): доступ даёт подпись `?sig=`,
   * а не initData — так картинку можно отправить в чат.
   */
  @Get(':chartId/wheel.svg')
  async wheel(
    @Param('chartId', new ParseUUIDPipe()) chartId: string,
    @Query('sig') signature: string | undefined,
    @Query('theme') theme: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    const svg = await this.charts.wheelSvg(chartId, signature, theme);

    res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.status(200).send(svg);
  }
}
