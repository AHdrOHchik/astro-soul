import { Module } from '@nestjs/common';
import { AstroModule } from '../astro/astro.module';
import { UsersRepository } from '../users/users.repository';
import { ChartsController } from './charts.controller';
import { ChartsRepository } from './charts.repository';
import { ChartsService } from './charts.service';
import { WheelSignatureService } from './wheel-signature.service';

@Module({
  imports: [AstroModule],
  controllers: [ChartsController],
  providers: [ChartsService, ChartsRepository, WheelSignatureService, UsersRepository],
  exports: [ChartsService, ChartsRepository],
})
export class ChartsModule {}
