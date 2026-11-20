import { Inject, Injectable } from '@nestjs/common';
import { APP_ENV } from '../../config/env.module';
import type { AppEnv } from '../../config/env';
import { JsonLogger } from '../../common/logger';
import {
  buildMiniAppUrl,
  parseStartChartId,
  parseStartShareShortId,
} from '../charts/share-link';
import { EventsRepository } from '../events/events.repository';
import { FileStorageService } from '../files/file-storage.service';
import { ShareRepository } from '../share/share.repository';
import { SHARE_CAPTION } from '../share/share.service';
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
    @Inject(ShareRepository) private readonly cards: ShareRepository,
    @Inject(FileStorageService) private readonly storage: FileStorageService,
    @Inject(EventsRepository) private readonly events: EventsRepository,
  ) {}

  async handleMessage(message: TelegramStartMessage): Promise<boolean> {
    const shortId = parseStartShareShortId(message.text);
    if (shortId !== null) {
      return this.handleSharedCard(shortId, message.chat.id);
    }

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

  /**
   * `/start sh_<short_id>` — человек нажал ссылку из пересланной карточки.
   *
   * Бот отвечает той же картинкой: пересланный текст без картинки читается как
   * спам, а карточка — как приглашение. Ссылка берётся свежая (подпись живёт
   * сутки и могла истечь с момента отправки), поэтому `short_id` живёт в БД, а
   * подпись генерируется здесь.
   *
   * Неизвестный `short_id` — не ошибка: карточку могли удалить вместе с
   * аккаунтом автора. Отвечаем текстом и ведём в приложение.
   */
  private async handleSharedCard(shortId: string, chatId: number): Promise<boolean> {
    const card = await this.cards.findByShortId(shortId);
    const url = this.env.MINI_APP_URL;

    if (card === null) {
      this.logger.warn('telegram_start_share_missing', { short_id: shortId });

      if (url !== undefined) {
        await this.telegram.sendMessage(chatId, 'Карточки больше нет, но приложение открывается 👇', {
          button: { text: 'Открыть', webAppUrl: url },
        });
      }

      // `true`: сообщение — наш `sh_`-формат, отвечать на него вторым `/start`
      // не нужно.
      return true;
    }

    const signed = this.storage.signedUrl(card.storage_key);

    await this.telegram.sendPhoto(
      chatId,
      signed.url,
      SHARE_CAPTION,
      url === undefined ? {} : { button: { text: 'Открыть', webAppUrl: url } },
    );

    // Два события без ПДн, и оба — правда о разных вещах:
    //   `share_card_opened` — человек нажал ссылку из карточки;
    //   `share_sent` — карточка ушла в чат (это единственная отправка, которую
    //   сервер видит своими глазами; клиентский inline-шеринг он не видит).
    // Кто переслал и кому — не пишем: получатель согласия не давал.
    await this.events.log({
      name: 'share_card_opened',
      props: { kind: card.kind, channel: 'link', cached: true },
    });
    await this.events.log({
      name: 'share_sent',
      props: { kind: card.kind, channel: 'telegram' },
    });

    return true;
  }
}
