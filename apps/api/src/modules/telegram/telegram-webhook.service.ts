import { Inject, Injectable } from '@nestjs/common';
import { APP_ENV } from '../../config/env.module';
import type { AppEnv } from '../../config/env';
import { JsonLogger } from '../../common/logger';
import { TelegramClient, type WebhookInfo } from './telegram.client';

/**
 * Вебхук Telegram как состояние, а не как «мы один раз выполнили curl из
 * DOCKER.md» (итерация 25).
 *
 * Проблема, из-за которой это появилось: `setWebhook` в кодовой базе не
 * вызывался нигде — адрес регистрировал человек по инструкции. Любой дрейф
 * (сменился домен, пересоздали контейнер с другим `TELEGRAM_WEBHOOK_SECRET`,
 * забыли выполнить шаг после переезда) означает, что `pre_checkout_query`
 * не приходит вообще: ссылка открывается, модал крутится, человек видит
 * «ошибка оплаты», и в наших логах нет ни одной строки о запросе.
 *
 * Поэтому: при старте API сверяет `getWebhookInfo` с адресом, собранным из
 * окружения, и при расхождении регистрирует вебхук заново. Идемпотентно,
 * `drop_pending_updates` не выставляется — в очереди могут лежать платежи.
 *
 * Отключается `TELEGRAM_WEBHOOK_AUTO=0` (например, если адрес регистрирует
 * внешний оркестратор): тогда сервис только проверяет и пишет в лог.
 */

/** Почему вебхук в таком состоянии — наружу для логов и `payments:diagnose`. */
export type WebhookState =
  | 'ok'
  | 'registered'
  | 'mismatch'
  | 'not_configured'
  | 'disabled'
  | 'unreachable'
  | 'failed';

export interface WebhookStatus {
  readonly state: WebhookState;
  /** Адрес, который должен быть зарегистрирован (null — собрать не из чего). */
  readonly expectedUrl: string | null;
  /** Адрес, который Telegram считает текущим. */
  readonly actualUrl: string | null;
  readonly pendingUpdateCount: number;
  readonly lastErrorMessage: string | null;
  readonly lastErrorDate: number | null;
  /** Текст ответа Bot API, если `setWebhook` не сработал. */
  readonly description: string | null;
}

@Injectable()
export class TelegramWebhookService {
  constructor(
    @Inject(TelegramClient) private readonly telegram: TelegramClient,
    @Inject(APP_ENV) private readonly env: AppEnv,
    @Inject(JsonLogger) private readonly logger: JsonLogger,
  ) {}

  /**
   * Адрес вебхука из окружения.
   *
   * Собирается из `MINI_APP_URL` (тот же публичный адрес, по которому открывается
   * мини-апп: nginx проксирует `/api/` в API) и секрета — тот же секрет
   * проверяется в пути и в заголовке `X-Telegram-Bot-Api-Secret-Token`.
   */
  expectedUrl(): string | null {
    const base = this.env.MINI_APP_URL;
    const secret = this.env.TELEGRAM_WEBHOOK_SECRET;

    if (base === undefined || secret === undefined) {
      return null;
    }

    return `${base.replace(/\/+$/, '')}/api/v1/internal/telegram/webhook/${secret}`;
  }

  /**
   * Проверить и при необходимости починить регистрацию.
   *
   * Никогда не бросает: недоступный Telegram или отсутствие настроек — это
   * повод для записи в лог, а не для отказа API стартовать (платежи важны, но
   * API без Telegram обязан подниматься).
   */
  async ensureRegistered(): Promise<WebhookStatus> {
    const expectedUrl = this.expectedUrl();

    if (expectedUrl === null) {
      const status: WebhookStatus = {
        state: 'not_configured',
        expectedUrl: null,
        actualUrl: null,
        pendingUpdateCount: 0,
        lastErrorMessage: null,
        lastErrorDate: null,
        description: null,
      };

      // Без секрета вебхук закрыт всегда (`webhook.controller.ts` → 403), без
      // `MINI_APP_URL` не из чего собрать адрес. В проде это блокер, и он
      // должен быть виден в первой же строке лога.
      this.logger.warn('telegram_webhook_not_configured', {
        has_secret: this.env.TELEGRAM_WEBHOOK_SECRET !== undefined,
        has_mini_app_url: this.env.MINI_APP_URL !== undefined,
        note: 'pre_checkout_query не доставляется — оплата не подтвердится',
      });

      return status;
    }

    const info = await this.telegram.getWebhookInfo();

    if (!info.reachable || info.result === null) {
      this.logger.error('telegram_webhook_unreachable', {
        status: info.status,
        description: info.description,
      });
      return {
        state: 'unreachable',
        expectedUrl,
        actualUrl: null,
        pendingUpdateCount: 0,
        lastErrorMessage: info.description,
        lastErrorDate: null,
        description: info.description,
      };
    }

    const actual = info.result;

    if (actual.url === expectedUrl) {
      this.logger.info('telegram_webhook_ok', {
        pending_update_count: actual.pendingUpdateCount,
        last_error_message: actual.lastErrorMessage,
        last_error_date: actual.lastErrorDate,
      });

      return this.status('ok', expectedUrl, actual, null);
    }

    // Адрес другой (или его нет). Это и есть причина «оплата не проходит» в
    // 90% случаев: Telegram шлёт `pre_checkout_query` на старый домен.
    this.logger.warn('telegram_webhook_mismatch', {
      actual_url: actual.url === '' ? null : actual.url,
      expected_url: expectedUrl,
      pending_update_count: actual.pendingUpdateCount,
      last_error_message: actual.lastErrorMessage,
    });

    if (this.env.TELEGRAM_WEBHOOK_AUTO === '0') {
      this.logger.warn('telegram_webhook_auto_disabled', {
        note: 'TELEGRAM_WEBHOOK_AUTO=0: адрес не меняем, чинить нужно вручную',
      });
      return this.status('mismatch', expectedUrl, actual, null);
    }

    const registered = await this.telegram.setWebhook(expectedUrl, this.env.TELEGRAM_WEBHOOK_SECRET ?? '');

    if (!registered.ok) {
      this.logger.error('telegram_webhook_registration_failed', {
        status: registered.status,
        description: registered.description,
      });
      return this.status('failed', expectedUrl, actual, registered.description);
    }

    const after = await this.telegram.getWebhookInfo();

    this.logger.warn('telegram_webhook_registered', {
      from: actual.url === '' ? null : actual.url,
      to: expectedUrl,
      verified: after.result?.url === expectedUrl,
    });

    return this.status(
      after.result?.url === expectedUrl ? 'registered' : 'failed',
      expectedUrl,
      after.result ?? actual,
      after.result?.url === expectedUrl ? null : 'setWebhook не подтвердился getWebhookInfo',
    );
  }

  private status(
    state: WebhookState,
    expectedUrl: string,
    info: WebhookInfo,
    description: string | null,
  ): WebhookStatus {
    return {
      state,
      expectedUrl,
      actualUrl: info.url === '' ? null : info.url,
      pendingUpdateCount: info.pendingUpdateCount,
      lastErrorMessage: info.lastErrorMessage,
      lastErrorDate: info.lastErrorDate,
      description,
    };
  }

  /** Строка состояния для `payments:diagnose` и логов — без секрета в пути. */
  describe(status: WebhookStatus): string {
    switch (status.state) {
      case 'ok':
        return 'вебхук зарегистрирован на ожидаемый адрес';
      case 'registered':
        return 'вебхук перерегистрирован на ожидаемый адрес';
      case 'mismatch':
        return 'адрес вебхука не совпадает с окружением — pre_checkout_query уходит не туда';
      case 'not_configured':
        return 'TELEGRAM_WEBHOOK_SECRET или MINI_APP_URL не заданы — вебхук не доставляется';
      case 'disabled':
        return 'проверка отключена (TELEGRAM_WEBHOOK_AUTO=0)';
      case 'unreachable':
        return 'Bot API недоступен — проверить сеть и токен';
      case 'failed':
        return 'setWebhook не удался — текст ошибки Bot API в описании';
    }
  }
}
