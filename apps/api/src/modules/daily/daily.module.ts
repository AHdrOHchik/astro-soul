import { Module } from '@nestjs/common';
import { AstroModule } from '../astro/astro.module';
import { PlansModule } from '../billing/plans.module';
import { ChartsModule } from '../charts/charts.module';
import { AccessService } from '../entitlements/access.service';
import { EntitlementsService } from '../entitlements/entitlements.service';
import { GrantsDataModule } from '../grants/grants-data.module';
import { EventsModule } from '../events/events.module';
import { LlmModule } from '../llm/llm.module';
import { UsersRepository } from '../users/users.repository';
import { DailyForecastController } from './daily-forecast.controller';
import { DailyForecastRepository } from './daily-forecast.repository';
import { DailyForecastService } from './daily-forecast.service';
import { QuestionsController } from './questions.controller';
import { QuestionsRepository } from './questions.repository';
import { QuestionsService } from './questions.service';

/**
 * «Прогноз дня» и «спроси карту» в одном модуле.
 *
 * Почему вместе: оба — платный контент по подписке, оба считают факты
 * сайдкаром и оба пишут расход в свою таблицу. Две квоты (сутки на прогноз,
 * 3 вопроса в сутки) читаются из одного окружения, и разносить их по разным
 * модулям значило бы дважды описать одну проверку подписки.
 */
@Module({
  imports: [AstroModule, LlmModule, ChartsModule, EventsModule, PlansModule, GrantsDataModule],
  controllers: [DailyForecastController, QuestionsController],
  providers: [
    DailyForecastService,
    DailyForecastRepository,
    QuestionsService,
    QuestionsRepository,
    EntitlementsService,
    AccessService,
    UsersRepository,
  ],
  exports: [DailyForecastService, QuestionsService],
})
export class DailyModule {}
