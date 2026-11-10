import { Module } from '@nestjs/common';
import { AstroModule } from '../astro/astro.module';
import { HealthController } from './health.controller';

@Module({
  imports: [AstroModule],
  controllers: [HealthController],
})
export class HealthModule {}
