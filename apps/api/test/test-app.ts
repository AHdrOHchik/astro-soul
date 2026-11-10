import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { DbService } from '../src/db/db.service';
import { applyTestEnv } from './test-env';

export interface TestContext {
  readonly app: INestApplication;
  readonly db: DbService;
  close(): Promise<void>;
}

/** Поднимает настоящее приложение (с БД и middleware), как в проде. */
export async function createTestContext(): Promise<TestContext> {
  applyTestEnv();

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication({ logger: false });

  app.setGlobalPrefix('api/v1');
  await app.init();

  const db = app.get(DbService);

  return {
    app,
    db,
    async close(): Promise<void> {
      await app.close();
    },
  };
}

const TABLES = [
  'events',
  'quotas',
  'entitlements',
  'payments',
  'invoices',
  'subscriptions',
  'asks',
  'forecasts',
  'reports',
  'charts',
  'profiles',
  'users',
] as const;

export async function truncateAll(db: DbService): Promise<void> {
  await db.query(`TRUNCATE ${TABLES.join(', ')} RESTART IDENTITY CASCADE`);
}
