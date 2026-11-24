import { MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { CommonModule } from './common/common.module';
import { ProblemDetailsFilter } from './common/problem-details.filter';
import { RateLimitMiddleware } from './common/rate-limit.middleware';
import { RequestIdMiddleware } from './common/request-id.middleware';
import { EnvModule } from './config/env.module';
import { DbModule } from './db/db.module';
import { AdminAuditModule } from './modules/admin-audit/admin-audit.module';
import { AdminAuthModule } from './modules/admin-auth/admin-auth.module';
import { AdminSupportModule } from './modules/admin-support/admin-support.module';
import { InitDataMiddleware } from './modules/auth/init-data.middleware';
import { BillingModule } from './modules/billing/billing.module';
import { ChartsModule } from './modules/charts/charts.module';
import { CompatModule } from './modules/compat/compat.module';
import { DailyModule } from './modules/daily/daily.module';
import { EventsModule } from './modules/events/events.module';
import { FilesModule } from './modules/files/files.module';
import { GeoModule } from './modules/geo/geo.module';
import { GrantsModule } from './modules/grants/grants.module';
import { HealthModule } from './modules/health/health.module';
import { MeModule } from './modules/me/me.module';
import { EngagementModule } from './modules/engagement/engagement.module';
import { OpsModule } from './modules/ops/ops.module';
import { PdfModule } from './modules/pdf/pdf.module';
import { ReportsModule } from './modules/reports/reports.module';
import { ShareModule } from './modules/share/share.module';
import { UsersRepository } from './modules/users/users.repository';
import { PresenceService } from './modules/users/presence.service';

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
    EngagementModule,
    OpsModule,
    ReportsModule,
    CompatModule,
    DailyModule,
    PdfModule,
    ShareModule,
    FilesModule,
    // Бесплатный доступ по праву (итерация 39): коды, «первые 50», приглашения.
    GrantsModule,
    // Админка (итерация 40, 1.6.15): сессии панели и журнал аудита.
    // `AdminAuthModule` нужен здесь не только ради маршрутов: его
    // `AdminSessionService` спрашивает middleware авторизации.
    AdminAuthModule,
    AdminAuditModule,
    // Панель поддержки и цен (итерация 41, 1.6.16): тарифы, пользователи,
    // разборы. Гард общий — префикс `/api/v1/admin*` в `InitDataMiddleware`.
    AdminSupportModule,
  ],
  providers: [
    // Присутствие (итерация 38) — провайдер корневого модуля: его спрашивает
    // middleware авторизации, а не какой-то один домен.
    UsersRepository,
    PresenceService,
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
