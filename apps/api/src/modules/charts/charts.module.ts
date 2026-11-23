import { Module } from '@nestjs/common';
import { AstroModule } from '../astro/astro.module';
import { GrantsModule } from '../grants/grants.module';
import { UsersRepository } from '../users/users.repository';
import { ChartsController } from './charts.controller';
import { ChartsRepository } from './charts.repository';
import { ChartsService } from './charts.service';
import { WheelSignatureService } from './wheel-signature.service';

@Module({
  // `GrantsModule` — потому что карта запускает ожидающие права и награду за
  // приглашение (1.6.14). Цикла нет: гранты про карты не знают, они спрашивают
  // БД одним `EXISTS`.
  imports: [AstroModule, GrantsModule],
  controllers: [ChartsController],
  providers: [ChartsService, ChartsRepository, WheelSignatureService, UsersRepository],
  exports: [ChartsService, ChartsRepository],
})
export class ChartsModule {}
