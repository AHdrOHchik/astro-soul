import { MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { CommonModule } from './common/common.module';
import { ProblemDetailsFilter } from './common/problem-details.filter';
import { RequestIdMiddleware } from './common/request-id.middleware';
import { EnvModule } from './config/env.module';
import { DbModule } from './db/db.module';
import { InitDataMiddleware } from './modules/auth/init-data.middleware';
import { HealthModule } from './modules/health/health.module';
import { MeModule } from './modules/me/me.module';

@Module({
  imports: [EnvModule, CommonModule, DbModule, HealthModule, MeModule],
  providers: [
    RequestIdMiddleware,
    InitDataMiddleware,
    { provide: APP_FILTER, useClass: ProblemDetailsFilter },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Порядок важен: сначала request_id (нужен в любом ответе, включая ошибки),
    // затем проверка initData на всех маршрутах, кроме публичных.
    consumer.apply(RequestIdMiddleware, InitDataMiddleware).forRoutes('*');
  }
}
