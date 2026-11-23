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
import { AccessCodesService } from '../grants/access-codes.service';
import { parsePartnerStart, startKind } from '../grants/grants-start';
import { ReferralsService, parseReferralStart } from '../grants/referrals.service';
import { DbService } from '../../db/db.service';
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
    @Inject(DbService) private readonly db: DbService,
    @Inject(AccessCodesService) private readonly codes: AccessCodesService,
    @Inject(ReferralsService) private readonly referrals: ReferralsService,
  ) {}

  async handleMessage(message: TelegramStartMessage): Promise<boolean> {
    // `pt_<code>` и `ref_<short>` (1.6.14) — до `chart_`/`sh_`: префиксы не
    // пересекаются, но порядок должен быть явным, чтобы новый вид ссылки не
    // уходил в обработчик карты «по остаточному принципу».
    if (startKind(this.startValue(message.text)) === 'partner') {
      return this.handlePartnerCode(message);
    }

    if (startKind(this.startValue(message.text)) === 'referral') {
      return this.handleReferral(message);
    }

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

  /** Значение после `/start ` — то, что Telegram положил в параметр `start`. */
  private startValue(text: string | undefined): string | undefined {
    const parts = text?.trim().split(/\s+/u) ?? [];

    return parts[0] === '/start' && parts.length === 2 ? parts[1] : undefined;
  }

  /** Пользователь по telegram_id; `null` — ещё не открывал мини-апп. */
  private async userIdOf(chatId: number): Promise<string | null> {
    const row = await this.db.queryOne<{ id: string }>(
      `SELECT id FROM users WHERE telegram_id = $1`,
      [String(chatId)],
    );

    return row?.id ?? null;
  }

  /**
   * `/start pt_<code>` — партнёрская ссылка (1.6.14).
   *
   * Код активируется сразу, и человеку **говорят, что он получил**: «доступ на
   * 14 дней» или «один разбор». Молчаливая активация выглядит как «ссылка
   * ничего не сделала», и человек идёт вводить код руками.
   *
   * Если аккаунта ещё нет (человек не открывал мини-апп), активировать некуда:
   * `grants` висит на `user_id`, которого нет. Отвечаем кнопкой с
   * `startapp=pt_<code>` — мини-апп передаст `start` в `GET /me`, и код
   * применится там. Так код не теряется и не «сгорает» на чужой аккаунт.
   */
  private async handlePartnerCode(message: TelegramStartMessage): Promise<boolean> {
    const code = parsePartnerStart(this.startValue(message.text));
    const url = this.env.MINI_APP_URL;

    if (code === null) {
      return false;
    }

    const userId = await this.userIdOf(message.chat.id);

    if (userId === null) {
      const link = url === undefined ? null : `${url}?startapp=pt_${code}`;

      await this.telegram.sendMessage(
        message.chat.id,
        'Открой приложение — код применим там, и права появятся сразу.',
        link === null ? {} : { button: { text: 'Открыть', webAppUrl: link } },
      );

      return true;
    }

    try {
      const activated = await this.codes.activate(userId, code);

      await this.telegram.sendMessage(message.chat.id, this.codes.describe(activated), {
        ...(url === undefined ? {} : { button: { text: 'Открыть', webAppUrl: url } }),
      });
    } catch (error) {
      // Неизвестный/просроченный/исчерпанный код — не ошибка бота: отвечаем
      // текстом и ведём в приложение. Точную причину человеку не показываем,
      // чтобы по ответу нельзя было перебирать коды.
      this.logger.warn('telegram_start_partner_failed', {
        code,
        reason: error instanceof Error ? error.message : String(error),
      });

      await this.telegram.sendMessage(
        message.chat.id,
        'Этот код не сработал. Проверь написание или спроси новый у того, кто его дал.',
        url === undefined ? {} : { button: { text: 'Открыть', webAppUrl: url } },
      );
    }

    return true;
  }

  /**
   * `/start ref_<short_id>` — приглашение друга (1.6.14).
   *
   * Записываем связь, только если человек уже есть в базе: приглашённым
   * считается новый аккаунт, и «пригласи себя старым» не должно давать месяц.
   * Незнакомый `short_id` — молча продолжаем обычный `/start`: приглашение не
   * должно ломать вход.
   */
  private async handleReferral(message: TelegramStartMessage): Promise<boolean> {
    const shortId = parseReferralStart(this.startValue(message.text));

    if (shortId === null) {
      return false;
    }

    const userId = await this.userIdOf(message.chat.id);

    if (userId === null) {
      // Аккаунта ещё нет: ссылку передадим мини-аппу, он применит её в `/me`.
      const url = this.env.MINI_APP_URL;
      const link = url === undefined ? null : `${url}?startapp=ref_${shortId}`;

      await this.telegram.sendMessage(
        message.chat.id,
        'Тебя пригласили. Открой приложение — приглашение применится само.',
        link === null ? {} : { button: { text: 'Открыть', webAppUrl: link } },
      );

      return true;
    }

    const result = await this.referrals.joinByShortId(shortId, userId);

    if (result !== 'joined') {
      this.logger.info('telegram_start_referral_skipped', { result });
    }

    // Ответ на приглашение не шлём отдельным сообщением: дальше идёт обычный
    // `/start` с онбордингом, и два сообщения подряд читаются как спам.
    return false;
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

    // Карточка открыта человеком — чистка её больше не тронет (1.6.14).
    // Не ждём: отметка не должна задерживать ответ бота.
    void this.cards.markOpened(shortId).catch(() => undefined);

    const signed = this.storage.signedUrl(card.storage_key);

    await this.telegram.sendPhoto(
      chatId,
      signed.url,
      SHARE_CAPTION,
      url === undefined ? {} : { button: { text: 'Открыть', webAppUrl: url } },
    );

    // Одно событие без ПДн: человек перешёл по ссылке из карточки. Отправку
    // (`share_sent`) с 1.6.9 пишет клиент — сервер видит только переход, и
    // называть переход отправкой значило бы считать одно и то же дважды.
    // Кто переслал и кому — не пишем: получатель согласия не давал.
    await this.events.log({
      name: 'share_card_opened',
      props: { kind: card.kind, channel: 'link', cached: true },
    });

    return true;
  }
}
