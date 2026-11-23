import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { APP_ENV } from './config/env.module';
import type { AppEnv } from './config/env';
import { JsonLogger } from './common/logger';
import {
  PROD_GUARD_EXIT_CODE,
  ProdGuardError,
  ProdGuardService,
} from './modules/ops/prod-guard.service';
import { TelegramInlineService } from './modules/telegram/telegram-inline.service';
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
  // Сервис живёт за прокси (`docs/DOCKER.md`): без этого `req.ip` — адрес
  // прокси, и лимит входа в панель (10 неудач за 15 минут) стал бы общим на
  // всех. Доверяем **одному** хопу — тому, что добавляет сам прокси; остальное
  // в `X-Forwarded-For` клиент может написать сам, и доверять этому нельзя.
  app.getHttpAdapter().getInstance().set('trust proxy', 1);
  app.enableShutdownHooks();

  process.on('unhandledRejection', (reason: unknown) => {
    logger.error('unhandled_rejection', { error: reason instanceof Error ? reason : String(reason) });
  });
  process.on('uncaughtException', (error: Error) => {
    logger.error('uncaught_exception', { error });
  });

  // Прод-гард (итерация 36, блокер Б-5) — **до** `listen`: сервис с тестовым
  // тарифом за 1 ⭐ или с выключенным брейкером не должен принять ни одного
  // запроса. `check.sh --prod` проверяет окружение, но не строки в `plans`, а
  // именно там и живёт тестовый тариф; здесь доступны обе половины.
  try {
    await app.get(ProdGuardService).assertSafe();
  } catch (error) {
    if (error instanceof ProdGuardError) {
      // Текст — «что не так и как исправить», по пунктам: дежурный читает лог,
      // а не исходники. Код выхода отдельный, чтобы это не путали с падением
      // самого приложения.
      logger.error('prod_guard_failed', {
        violations: error.violations,
        exit_code: PROD_GUARD_EXIT_CODE,
        report: error.report(),
      });
      await app.close();
      process.exit(PROD_GUARD_EXIT_CODE);
    }
    throw error;
  }

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
      // Человеческий текст для тех состояний, где нужно действие (итерация 26).
      hint: status.hint ?? null,
      health: webhook.health(),
    });
  } catch (error) {
    logger.error('telegram_webhook_check_failed', {
      error: error instanceof Error ? error.name : 'unknown',
    });
  }

  // Inline-режим бота: от него зависит основной путь шаринга
  // (`switchInlineQuery`). Настройка живёт в BotFather и кодом не включается,
  // поэтому на старте мы её спрашиваем и называем вслух — иначе выключенный
  // inline выглядит как «кнопка «Поделиться» ничего не делает».
  try {
    await app.get(TelegramInlineService).checkMode();
  } catch (error) {
    logger.warn('telegram_inline_check_failed', {
      error: error instanceof Error ? error.name : 'unknown',
    });
  }

  // Выключенный брейкер — не «мелочь в .env»: без него массовый провал
  // валидации снова жжёт бюджет на каждом заказе. Один WARN на старте, чтобы
  // это было видно в логах того же дня, а не выяснялось по счёту.
  // Пуш по умолчанию выключен — это нормальное состояние продукта, а не
  // ошибка. Но включённый пуш — единственная рассылка, которая пишет людям от
  // нашего имени, поэтому в лог старта попадает и «включён»: при разборе
  // «почему пришло сообщение» первым делом смотрят именно это.
  if (env.PUSH_ENABLED === '1') {
    logger.info('push_enabled', {
      flag: 'PUSH_ENABLED',
      send_hour: env.PUSH_SEND_HOUR,
      window_minutes: env.PUSH_WINDOW_MINUTES,
      batch_size: env.PUSH_BATCH_SIZE,
    });
  }

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
