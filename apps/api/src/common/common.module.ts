import { Global, Module } from '@nestjs/common';
import { APP_ENV, EnvModule } from '../config/env.module';
import type { AppEnv } from '../config/env';
import { JsonLogger } from './logger';

@Global()
@Module({
  imports: [EnvModule],
  providers: [
    {
      provide: JsonLogger,
      inject: [APP_ENV],
      useFactory: (env: AppEnv) => new JsonLogger(env.LOG_LEVEL, { app: 'astro-soul-api' }),
    },
  ],
  exports: [JsonLogger],
})
export class CommonModule {}
