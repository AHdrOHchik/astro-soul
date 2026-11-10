import { Module } from '@nestjs/common';
import { AstroClient } from './astro.client';

@Module({
  providers: [AstroClient],
  exports: [AstroClient],
})
export class AstroModule {}
