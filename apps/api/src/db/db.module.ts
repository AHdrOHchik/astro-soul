import { Global, Module } from '@nestjs/common';
import { EnvModule, APP_ENV } from '../config/env.module';
import type { AppEnv } from '../config/env';
import { createPgPool, DbService, PG_POOL } from './db.service';

@Global()
@Module({
  imports: [EnvModule],
  providers: [
    {
      provide: PG_POOL,
      inject: [APP_ENV],
      useFactory: (env: AppEnv) => createPgPool(env),
    },
    DbService,
  ],
  exports: [PG_POOL, DbService],
})
export class DbModule {}
