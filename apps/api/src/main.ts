import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { APP_ENV } from './config/env.module';
import type { AppEnv } from './config/env';
import { JsonLogger } from './common/logger';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: false,
    bufferLogs: false,
  });
  const env = app.get<AppEnv>(APP_ENV);
  const logger = app.get(JsonLogger);

  app.setGlobalPrefix('api/v1');
  // Битый JSON в теле — это 400 от контракта, а не HTML-страница Express.
  app.useBodyParser('json', { limit: '64kb' });
  app.getHttpAdapter().getInstance().disable('x-powered-by');
  app.enableShutdownHooks();

  process.on('unhandledRejection', (reason: unknown) => {
    logger.error('unhandled_rejection', { error: reason instanceof Error ? reason : String(reason) });
  });
  process.on('uncaughtException', (error: Error) => {
    logger.error('uncaught_exception', { error });
  });

  const port = env.PORT;
  // 0.0.0.0: контейнер должен принимать трафик снаружи, не только из localhost.
  await app.listen(port, '0.0.0.0');

  logger.info('api_started', {
    port,
    env: env.NODE_ENV,
    version: env.APPLICATION_VERSION,
    astro_engine: env.ASTRO_ENGINE,
  });
}

bootstrap().catch((error: unknown) => {
  process.stderr.write(
    JSON.stringify({
      ts: new Date().toISOString(),
      level: 'error',
      msg: 'api_bootstrap_failed',
      error: error instanceof Error ? { name: error.name, message: error.message } : String(error),
    }) + '\n',
  );
  process.exit(1);
});
