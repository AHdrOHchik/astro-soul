import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { AstroClient } from '../src/modules/astro/astro.client';
import { TelegramClient } from '../src/modules/telegram/telegram.client';
import { DbService } from '../src/db/db.service';
import { LLM_PROVIDER } from '../src/modules/llm/llm.module';
import type { LlmProvider } from '../src/modules/llm/llm.client';
import { applyRequestContext } from '../src/common/request-id.middleware';
import { applyTestEnv } from './test-env';

export interface TestContext {
  readonly app: INestApplication;
  readonly db: DbService;
  close(): Promise<void>;
}

export interface TestContextOptions {
  /** Подмена сайдкара движка: в тестах не поднимаем Python-процесс. */
  readonly astro?: Pick<AstroClient, 'createChart' | 'transits' | 'wheelSvg' | 'health' | 'isConfigured'>;
  /** Подмена Bot API: никаких сетевых вызовов в тестах. */
  readonly telegram?: Pick<
    TelegramClient,
    'createInvoiceLink' | 'answerPreCheckoutQuery' | 'sendMessage' | 'refundStarPayment'
  >;
  /** Подмена провайдера LLM: в тестах не тратим деньги и не ходим в сеть. */
  readonly llm?: LlmProvider;
  /** Точечные переопределения окружения (например, включить лимиты запросов). */
  readonly env?: Readonly<Record<string, string>>;
}

/** Поднимает настоящее приложение (с БД и middleware), как в проде. */
export async function createTestContext(options: TestContextOptions = {}): Promise<TestContext> {
  applyTestEnv();

  for (const [key, value] of Object.entries(options.env ?? {})) {
    process.env[key] = value;
  }

  const builder = Test.createTestingModule({ imports: [AppModule] });
  if (options.astro !== undefined) {
    builder.overrideProvider(AstroClient).useValue(options.astro);
  }
  if (options.telegram !== undefined) {
    builder.overrideProvider(TelegramClient).useValue(options.telegram);
  }
  if (options.llm !== undefined) {
    builder.overrideProvider(LLM_PROVIDER).useValue(options.llm);
  }

  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication({ logger: false });

  app.setGlobalPrefix('api/v1');
  // Как в main.ts: request_id появляется до разбора тела (QA-12b).
  applyRequestContext(app);
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
