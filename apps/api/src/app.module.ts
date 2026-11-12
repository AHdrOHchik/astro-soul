import { MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { CommonModule } from './common/common.module';
import { ProblemDetailsFilter } from './common/problem-details.filter';
import { RateLimitMiddleware } from './common/rate-limit.middleware';
import { RequestIdMiddleware } from './common/request-id.middleware';
import { EnvModule } from './config/env.module';
import { DbModule } from './db/db.module';
import { InitDataMiddleware } from './modules/auth/init-data.middleware';
import { BillingModule } from './modules/billing/billing.module';
import { ChartsModule } from './modules/charts/charts.module';
import { EventsModule } from './modules/events/events.module';
import { GeoModule } from './modules/geo/geo.module';
import { HealthModule } from './modules/health/health.module';
import { MeModule } from './modules/me/me.module';
import { OpsModule } from './modules/ops/ops.module';

@Module({
  imports: [
    EnvModule,
    CommonModule,
    DbModule,
    HealthModule,
    MeModule,
    ChartsModule,
    BillingModule,
    GeoModule,
    EventsModule,
    OpsModule,
  ],
  providers: [
    RequestIdMiddleware,
    InitDataMiddleware,
    RateLimitMiddleware,
    { provide: APP_FILTER, useClass: ProblemDetailsFilter },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Порядок важен: сначала request_id (нужен в любом ответе, включая ошибки),
    // затем initData (даёт пользователя для ключа лимита), затем лимиты.
    consumer.apply(RequestIdMiddleware, InitDataMiddleware, RateLimitMiddleware).forRoutes('*');
  }
}
