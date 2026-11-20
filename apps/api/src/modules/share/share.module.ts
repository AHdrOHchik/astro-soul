import { Module } from '@nestjs/common';
import { AstroModule } from '../astro/astro.module';
import { EventsModule } from '../events/events.module';
import { FilesModule } from '../files/files.module';
import { UsersRepository } from '../users/users.repository';
import { ShareController } from './share.controller';
import { ShareRepository } from './share.repository';
import { ShareService } from './share.service';

/**
 * Карточки для шеринга.
 *
 * `ReportsModule` не нужен: цитату для `insight` берём прямо из `chapters`
 * последнего готового разбора, а не через сервис разбора — сервис тянет за
 * собой LLM и весь конвейер.
 */
@Module({
  imports: [AstroModule, EventsModule, FilesModule],
  controllers: [ShareController],
  providers: [ShareService, ShareRepository, UsersRepository],
  exports: [ShareService, ShareRepository],
})
export class ShareModule {}
