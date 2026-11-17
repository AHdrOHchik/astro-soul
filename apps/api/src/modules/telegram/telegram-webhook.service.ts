import { Inject, Injectable } from '@nestjs/common';
import { APP_ENV } from '../../config/env.module';
import type { AppEnv } from '../../config/env';
import { JsonLogger } from '../../common/logger';
import { TelegramClient, type WebhookInfo } from './telegram.client';
import { hostFromUrl, resolveHost, webhookUnreachableHint } from './webhook-address';

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
 *
 * Итерация 26 добавляет к этому две вещи, без которых «настроили один раз»
 * снова означало «однажды перестало работать молча»:
 *   • **резолв хоста `MINI_APP_URL` до вызова Bot API**. `setWebhook` на
 *     нерезолвящийся адрес возвращает `ok: true` — Telegram не проверяет наш
 *     DNS, — и дальше `pre_checkout_query` просто не приходит. Теперь такой
 *     случай называется вслух: WARN с хостом, следствием и лечением;
 *   • **состояние вебхука хранится**, а не только пишется в лог: `/health`
 *     отдаёт `telegram_webhook: ok|stale|unreachable`, `/admin/metrics` —
 *     `telegram_webhook_ok` и `telegram_webhook_checked_at`. Так «оплата не
 *     проходит» видно снаружи, не читая логи контейнера.
 */

/**
 * Сколько результат проверки считается свежим (итерация 26).
 *
 * Проверка идёт при старте API и по запросу (диагностика). Если старт был
 * сутки назад, а туннель с тех пор перезапустили с новым адресом, `ok` в
 * `/health` — это `stale`: мы не знаем, что там сейчас, и делать вид, что
 * знаем, хуже, чем признать.
 */
export const TELEGRAM_WEBHOOK_STALE_AFTER_MS = 24 * 60 * 60 * 1000;

/** Значение `GET /health` → `telegram_webhook`. */
export type WebhookHealthState = 'ok' | 'stale' | 'unreachable';

export interface WebhookHealth {
  readonly state: WebhookHealthState;
  /** Проверено ли состояние `ok` (для `/admin/metrics`). */
  readonly ok: boolean;
  readonly checkedAt: string | null;
}

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
  /** Человеческий текст для WARN: что не так и что делать (итерация 26). */
  readonly hint?: string | null;
  /**
   * Почему `unreachable`: не резолвится наш адрес или не отвечает Bot API.
   * Разные причины — разные действия, поэтому и в выводе они разные.
   */
  readonly cause?: 'dns' | 'bot_api' | null;
}

@Injectable()
export class TelegramWebhookService {
  constructor(
    @Inject(TelegramClient) private readonly telegram: TelegramClient,
    @Inject(APP_ENV) private readonly env: AppEnv,
    @Inject(JsonLogger) private readonly logger: JsonLogger,
  ) {}

  /** Результат последней проверки: его читают `/health` и `/admin/metrics`. */
  private lastStatus: WebhookStatus | null = null;
  private lastCheckedAt: Date | null = null;

  /**
   * Резолвится ли хост ожидаемого адреса — без похода в Bot API.
   *
   * Публично, потому что `payments:diagnose` проверяет то же самое, и подсказка
   * про туннель должна быть одной и той же строкой в логе и в выводе скрипта.
   */
  async checkHost(): Promise<ReturnType<typeof resolveHost>> {
    const expectedUrl = this.expectedUrl();
    return resolveHost(hostFromUrl(expectedUrl));
  }

  /**
   * Состояние вебхука для `/health`.
   *
   * Три значения, а не два, потому что «не проверяли» — не то же самое, что
   * «не работает»: `stale` значит «результат старше суток или проверки не
   * было», и это повод перезапустить API/диагностику, а не чинить Telegram.
   */
  health(): WebhookHealth {
    const status = this.lastStatus;
    const checkedAt = this.lastCheckedAt?.toISOString() ?? null;

    if (status === null || this.lastCheckedAt === null) {
      return { state: 'stale', ok: false, checkedAt };
    }

    const ageMs = Date.now() - this.lastCheckedAt.getTime();
    const fresh = ageMs < TELEGRAM_WEBHOOK_STALE_AFTER_MS;

    if (status.state === 'unreachable' || status.state === 'failed' || status.state === 'not_configured') {
      return { state: 'unreachable', ok: false, checkedAt };
    }

    if (status.state === 'ok' || status.state === 'registered') {
      return { state: fresh ? 'ok' : 'stale', ok: fresh, checkedAt };
    }

    // `mismatch` (адрес не тот, автопочинка выключена) и `disabled` —
    // «не знаем, что сейчас»: оплата может не доходить, но и утверждать, что
    // вебхук мёртв, нельзя.
    return { state: 'stale', ok: false, checkedAt };
  }

  private remember(status: WebhookStatus): WebhookStatus {
    this.lastStatus = status;
    this.lastCheckedAt = new Date();
    return status;
  }

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

      return this.remember(status);
    }

    // Сначала — резолвится ли хост, и только потом Bot API. `setWebhook` на
    // нерезолвящийся адрес Telegram принимает (`ok: true`), после чего
    // pre_checkout_query не доставляется: «настроили и тихо умерло». Дешевле
    // узнать это здесь, чем из жалобы «оплата не проходит».
    const resolution = await resolveHost(hostFromUrl(expectedUrl));

    if (!resolution.resolvable) {
      const hint = webhookUnreachableHint(resolution);

      this.logger.warn('telegram_webhook_unreachable', {
        expected_url: expectedUrl,
        host: resolution.host,
        dns_error: resolution.error,
        hint,
        note: 'setWebhook не вызывался: адрес не резолвится, доставка апдейтов невозможна',
      });

      return this.remember({
        state: 'unreachable',
        expectedUrl,
        actualUrl: null,
        pendingUpdateCount: 0,
        lastErrorMessage: resolution.error,
        lastErrorDate: null,
        description: hint,
        hint,
        cause: 'dns',
      });
    }

    this.logger.info('telegram_webhook_host_resolved', {
      host: resolution.host,
      addresses: resolution.addresses,
    });

    const info = await this.telegram.getWebhookInfo();

    if (!info.reachable || info.result === null) {
      const hint =
        'Bot API не отвечает: проверь сеть контейнера API и TELEGRAM_BOT_TOKEN — ' +
        'без этого вебхук не зарегистрировать и оплата не пройдёт';

      this.logger.error('telegram_webhook_unreachable', {
        status: info.status,
        description: info.description,
        hint,
        cause: 'bot_api',
      });
      return this.remember({
        state: 'unreachable',
        expectedUrl,
        actualUrl: null,
        pendingUpdateCount: 0,
        lastErrorMessage: info.description,
        lastErrorDate: null,
        description: info.description,
        hint,
        cause: 'bot_api',
      });
    }

    const actual = info.result;

    if (actual.url === expectedUrl) {
      this.logger.info('telegram_webhook_ok', {
        pending_update_count: actual.pendingUpdateCount,
        last_error_message: actual.lastErrorMessage,
        last_error_date: actual.lastErrorDate,
      });

      return this.remember(this.status('ok', expectedUrl, actual, null));
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
      return this.remember(this.status('mismatch', expectedUrl, actual, null));
    }

    const registered = await this.telegram.setWebhook(expectedUrl, this.env.TELEGRAM_WEBHOOK_SECRET ?? '');

    if (!registered.ok) {
      this.logger.error('telegram_webhook_registration_failed', {
        status: registered.status,
        description: registered.description,
        hint:
          'setWebhook отвергнут Bot API: чаще всего это неверный TELEGRAM_BOT_TOKEN ' +
          'или адрес с недопустимой схемой. Оплата в Telegram работать не будет',
      });
      return this.remember(this.status('failed', expectedUrl, actual, registered.description));
    }

    const after = await this.telegram.getWebhookInfo();

    this.logger.warn('telegram_webhook_registered', {
      from: actual.url === '' ? null : actual.url,
      to: expectedUrl,
      verified: after.result?.url === expectedUrl,
    });

    return this.remember(
      this.status(
        after.result?.url === expectedUrl ? 'registered' : 'failed',
        expectedUrl,
        after.result ?? actual,
        after.result?.url === expectedUrl ? null : 'setWebhook не подтвердился getWebhookInfo',
      ),
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
        return status.cause === 'dns'
          ? 'адрес MINI_APP_URL не резолвится — Telegram не доставит pre_checkout_query'
          : 'Bot API недоступен — проверить сеть и токен';
      case 'failed':
        return 'setWebhook не удался — текст ошибки Bot API в описании';
    }
  }
}
