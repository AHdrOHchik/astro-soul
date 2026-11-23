import { Module } from '@nestjs/common';
import { EventsModule } from '../events/events.module';
import { AdminAuditController } from './admin-audit.controller';
import { AdminAuditRepository } from './admin-audit.repository';
import { AdminAuditService } from './admin-audit.service';

/**
 * Журнал аудита (1.6.15). Отдельный модуль, а не часть `ops`: запись журнала
 * нужна и входу (`admin-auth`), и выдачам прав (`ops`). Если бы сервис жил в
 * `ops`, модуль входа импортировал бы `ops` целиком — и получил бы цикл
 * `ops → grants → …`, которого здесь нет.
 *
 * `DbService`, `APP_ENV` и `JsonLogger` приходят из глобальных модулей.
 */
@Module({
  // `EventsModule` — ради события `admin_audit_write_failed`.
  imports: [EventsModule],
  controllers: [AdminAuditController],
  providers: [AdminAuditRepository, AdminAuditService],
  exports: [AdminAuditRepository, AdminAuditService],
})
export class AdminAuditModule {}
