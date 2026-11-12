import { Inject, Injectable } from '@nestjs/common';
import { APP_ENV } from '../../config/env.module';
import type { AppEnv } from '../../config/env';
import { JsonLogger } from '../../common/logger';
import { buildMiniAppUrl, parseStartChartId } from '../charts/share-link';
import { TelegramClient } from './telegram.client';

export interface TelegramStartMessage {
  readonly chat: { readonly id: number };
  readonly text?: string;
}

/**
 * `/start chart_<id>` — возврат в мини-апп на конкретную карту.
 *
 * Сценарий из контракта 1.4.0: пользователь получил ссылку
 * `https://t.me/{bot}?startapp=chart_{chart_id}`, нажал её, Telegram прислал
 * боту `/start chart_<id>`. Без обработчика бот молчит, а мини-апп открывается
 * на пустом онбординге — то есть ссылка «на карту» ведёт в никуда.
 *
 * Карту отдаёт `GET /charts/current` (мини-апп уже авторизован initData),
 * поэтому бот не ходит в БД и не проверяет владельца: чужой `chart_id`
 * превратится в 404 и обычный онбординг.
 */
@Injectable()
export class TelegramStartService {
  constructor(
    @Inject(TelegramClient) private readonly telegram: TelegramClient,
    @Inject(APP_ENV) private readonly env: AppEnv,
    @Inject(JsonLogger) private readonly logger: JsonLogger,
  ) {}

  async handleMessage(message: TelegramStartMessage): Promise<boolean> {
    const chartId = parseStartChartId(message.text);
    if (chartId === null) {
      return false;
    }

    const url = buildMiniAppUrl(this.env.MINI_APP_URL, chartId);

    if (url === null) {
      // Без MINI_APP_URL кнопку не собрать: пусть откроется обычный /start,
      // лучше «открой приложение», чем битая кнопка.
      this.logger.warn('telegram_start_without_mini_app_url', { chart: chartId });
      return false;
    }

    await this.telegram.sendMessage(message.chat.id, 'Твоя карта готова — открывай 👇', {
      button: { text: 'Открыть карту', webAppUrl: url },
    });

    return true;
  }
}
