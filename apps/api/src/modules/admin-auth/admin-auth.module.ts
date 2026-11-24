import { Module } from '@nestjs/common';
import { AdminAuditModule } from '../admin-audit/admin-audit.module';
import { EventsModule } from '../events/events.module';
import { AdminAuthController } from './admin-auth.controller';
import { AdminLoginThrottle } from './admin-login-throttle.service';
import { AdminSessionService } from './admin-session.service';
import { AdminSessionsRepository } from './admin-sessions.repository';

/**
 * Вход и сессии админ-панели (1.6.15).
 *
 * `AdminSessionService` экспортируется: его спрашивают middleware авторизации
 * (проверка cookie на каждом `/admin/*`) и `/health` (`sessions_active`).
 * `AdminLoginThrottle` экспортируется для тестов, которым нужен сброс счётчиков
 * между сценариями: счётчик живёт в памяти процесса, а не в базе.
 */
@Module({
  // `EventsModule` — ради серверных событий `admin_login`/`admin_logout`.
  imports: [AdminAuditModule, EventsModule],
  controllers: [AdminAuthController],
  providers: [AdminSessionsRepository, AdminLoginThrottle, AdminSessionService],
  exports: [AdminSessionsRepository, AdminLoginThrottle, AdminSessionService],
})
export class AdminAuthModule {}
