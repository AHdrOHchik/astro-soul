import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { APP_ENV } from './config/env.module';
import type { AppEnv } from './config/env';
import { JsonLogger } from './common/logger';
import { TelegramWebhookService } from './modules/telegram/telegram-webhook.service';
import { applyRequestContext } from './common/request-id.middleware';

/**
 * Адрес вебхука содержит секрет в пути — в лог он целиком попасть не должен,
 * но по последним символам видно, тот это секрет или нет.
 */
function maskSecret(url: string): string {
  return url.replace(/webhook\/(.+)$/, (_match, secret: string) =>
    `webhook/***${secret.slice(-4)}`,
  );
}

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: false,
    bufferLogs: false,
  });
  const env = app.get<AppEnv>(APP_ENV);
  const logger = app.get(JsonLogger);

  app.setGlobalPrefix('api/v1');
  // QA-12b: request_id должен быть в ответе даже на битый JSON, а парсер тела
  // срабатывает раньше middleware Nest'а — поэтому контекст ставим первым.
  applyRequestContext(app);
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

  const testPlans = env.PAYMENTS_TEST_PLANS === '1';
  logger.info('api_started', {
    port,
    env: env.NODE_ENV,
    version: env.APPLICATION_VERSION,
    astro_engine: env.ASTRO_ENGINE,
    // Единственный способ убедиться, что флаг доехал до процесса: он нигде
    // больше не виден снаружи, а витрина от него не меняется (см. DOCKER.md).
    test_plans: testPlans,
  });
  if (testPlans) {
    logger.warn('test_plans_enabled', {
      plans: ['test_1', 'test_report_1'],
      note: 'тарифы за 1 ⭐ доступны через POST /billing/invoice',
    });
  }

  // Вебхук: проверить и при расхождении перерегистрировать. Ошибка не мешает
  // API работать (приём платежей важнее, но сервис поднимается всегда), зато
  // «pre_checkout_query не доставляется» перестаёт быть невидимым.
  try {
    const webhook = app.get(TelegramWebhookService);
    const status = await webhook.ensureRegistered();

    logger.info('telegram_webhook_state', {
      state: status.state,
      description: webhook.describe(status),
      expected_url: status.expectedUrl === null ? null : maskSecret(status.expectedUrl),
      actual_url: status.actualUrl === null ? null : maskSecret(status.actualUrl),
      pending_update_count: status.pendingUpdateCount,
      last_error_message: status.lastErrorMessage,
    });
  } catch (error) {
    logger.error('telegram_webhook_check_failed', {
      error: error instanceof Error ? error.name : 'unknown',
    });
  }

  // Выключенный брейкер — не «мелочь в .env»: без него массовый провал
  // валидации снова жжёт бюджет на каждом заказе. Один WARN на старте, чтобы
  // это было видно в логах того же дня, а не выяснялось по счёту.
  if (env.REPORT_BREAKER_ENABLED === '0') {
    logger.warn('report_breaker_disabled', {
      flag: 'REPORT_BREAKER_ENABLED',
      note: 'circuit breaker разборов не блокирует запуск: POST /reports не отвечает 503 report_breaker_open',
    });
  }
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
