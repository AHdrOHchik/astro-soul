import { Inject, Injectable } from '@nestjs/common';
import { JsonLogger } from '../../common/logger';
import { parseInlineQueryShortId } from '../charts/share-link';
import { FileStorageService } from '../files/file-storage.service';
import { SHARE_CAPTION } from '../share/share.service';
import { INLINE_KINDS, ShareRepository } from '../share/share.repository';
import { TelegramClient } from './telegram.client';

/** `inline_query` из апдейта Telegram: что человек набрал после `@bot`. */
export interface TelegramInlineQuery {
  readonly id: string;
  readonly query: string;
}

/** Состояние inline-режима бота: `unknown` — Bot API не ответил. */
export type InlineModeState = 'on' | 'off' | 'unknown';

/**
 * Inline-режим бота (контракт 1.6.9).
 *
 * Зачем это здесь. Основной путь шаринга в мини-аппе — `switchInlineQuery`:
 * человек нажимает «Поделиться», Telegram открывает выбор чата, а в чате
 * появляется карточка, которую прислал **бот**. Но `switchInlineQuery` работает
 * только если у бота включён inline-режим (`/setinline` в `@BotFather`), и до
 * этой итерации бэкенд умел только `/start sh_<short_id>` — то есть отвечал на
 * переход по ссылке, но не на inline-запрос. Если inline-режим выключен, кнопка
 * «Поделиться» молча не делает ничего — а это и есть самый частый путь.
 *
 * Что делает сервис:
 *   • `handleQuery` — отвечает на `inline_query` одной карточкой-картинкой
 *     (`InlineQueryResultPhoto` с подписью) или пустым списком, если метки в
 *     запросе нет;
 *   • `checkMode` — на старте спрашивает `getMe` про
 *     `supports_inline_queries` и пишет в лог, включён ли режим. Настройка
 *     живёт в BotFather, кодом её не включить, поэтому единственное, что можно
 *     сделать из кода, — перестать молчать;
 *   • `mode` — последнее известное состояние для `GET /me` (контракт 1.6.10):
 *     клиент выбирает `switchInlineQuery` или `share_url` + `openTelegramLink`
 *     ещё до того, как создаст карточку.
 *
 * Событий продукта здесь нет намеренно: ответ на inline-запрос — это показ
 * карточки человеку, а не отправка. Отправку (`share_sent`) видит только
 * клиент и присылает сам, поэтому «поделились» считается один раз.
 */
@Injectable()
export class TelegramInlineService {
  constructor(
    @Inject(TelegramClient) private readonly telegram: TelegramClient,
    @Inject(ShareRepository) private readonly cards: ShareRepository,
    @Inject(FileStorageService) private readonly storage: FileStorageService,
    @Inject(JsonLogger) private readonly logger: JsonLogger,
  ) {}

  /**
   * Последнее известное состояние inline-режима. `null` — проверки ещё не
   * было (API только поднялся, `checkMode` не вызывался).
   */
  private lastState: InlineModeState | null = null;

  /**
   * Состояние для `GET /me` (контракт 1.6.10).
   *
   * `unknown` — не «выключен»: режим мог быть включён после последней
   * проверки. Кэша дольше жизни процесса нет намеренно: `/setinline` меняет
   * ответ Bot API в любой момент, и следующий старт API его подхватит.
   */
  mode(): InlineModeState {
    return this.lastState ?? 'unknown';
  }

  /**
   * `inline_query` → `answerInlineQuery`. Возвращает `true`, если апдейт наш:
   * по этому признаку вебхук понимает, что обрабатывать больше нечего.
   */
  async handleQuery(query: TelegramInlineQuery): Promise<boolean> {
    const shortId = parseInlineQueryShortId(query.query);

    if (shortId === null) {
      await this.telegram.answerInlineQuery(query.id, []);
      this.logger.info('share_inline_empty', { reason: 'no_short_id' });
      return true;
    }

    const card = await this.cards.findByShortId(shortId);

    if (card === null) {
      // Карточку могли удалить вместе с аккаунтом автора. Пустой ответ — не
      // ошибка: человек увидит «ничего не найдено» и вернётся в приложение.
      await this.telegram.answerInlineQuery(query.id, []);
      this.logger.warn('share_inline_missing', { short_id: shortId });
      return true;
    }

    if (!INLINE_KINDS.includes(card.kind)) {
      // Вид, которого inline не знает: строку могла оставить будущая версия
      // сервера. Пустой ответ и предупреждение — карточку никто не увидит.
      await this.telegram.answerInlineQuery(query.id, []);
      this.logger.warn('share_inline_unsupported_kind', { kind: card.kind, short_id: shortId });
      return true;
    }

    const signed = this.storage.signedUrl(card.storage_key);

    await this.telegram.answerInlineQuery(query.id, [
      {
        type: 'photo',
        // `id` результата — `short_id`: стабильный и без чужих идентификаторов.
        id: shortId,
        photo_url: signed.url,
        thumbnail_url: signed.url,
        photo_width: card.width,
        photo_height: card.height,
        caption: SHARE_CAPTION,
      },
    ]);

    this.logger.info('share_inline_answered', { kind: card.kind, short_id: shortId });

    return true;
  }

  /**
   * Включён ли inline-режим у бота. Никогда не бросает: ответ Bot API — это
   * диагностика, а не условие старта API.
   */
  async checkMode(): Promise<InlineModeState> {
    const answer = await this.telegram.getMe();

    if (!answer.ok || answer.result === null) {
      // Состояние не сбрасываем: если раньше проверка удалась, «не ответил»
      // сейчас — это «не знаем сейчас», а не «выключено».
      this.logger.warn('telegram_inline_mode', {
        state: 'unknown',
        hint: 'Bot API не ответил на getMe: включён ли inline-режим — неизвестно',
      });
      return 'unknown';
    }

    const state: InlineModeState = answer.result.supports_inline_queries === true ? 'on' : 'off';
    this.lastState = state;

    if (state === 'off') {
      this.logger.warn('telegram_inline_mode', {
        state,
        hint:
          'inline-режим выключен: switchInlineQuery не откроет выбор чата. ' +
          'BotFather → /setinline, затем перезапуск API не нужен',
      });
      return state;
    }

    this.logger.info('telegram_inline_mode', { state });
    return state;
  }
}
