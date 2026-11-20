import { Controller, Get, Inject } from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator';
import type { VerifiedInitData } from '../auth/init-data';
import { DailyForecastService, type ForecastDayView } from './daily-forecast.service';

/**
 * `GET /api/v1/forecast/today` (контракт 1.6.6).
 *
 * Маршрута «перегенерировать» нет и не будет: прогноз один на сутки, и это
 * свойство продукта, а не экономия. Кнопка «ещё вариант» превратила бы
 * бесплатный для человека экран в платный для нас цикл.
 */
@Controller('forecast')
export class DailyForecastController {
  constructor(@Inject(DailyForecastService) private readonly forecast: DailyForecastService) {}

  @Get('today')
  async today(@CurrentUser() auth: VerifiedInitData): Promise<ForecastDayView> {
    return this.forecast.today(auth);
  }
}
