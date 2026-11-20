import { Controller, Get, Inject, Param, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { JsonLogger } from '../../common/logger';
import { forbidden, notFound, reasonOptions } from '../../common/api-error';
import { PdfRepository } from '../pdf/pdf.repository';
import { EventsRepository } from '../events/events.repository';
import { FileStorageService } from './file-storage.service';

/**
 * `GET /api/v1/files/{key}?sig=…` — единственный вход к приватным файлам.
 *
 * Маршрут публичный (`security: []` в контракте): право на файл даёт подпись, а
 * не initData. Это нужно, потому что PDF открывают по ссылке из браузера и
 * картинку вставляет Telegram — там никакого initData нет.
 *
 * Почему не отдаём файл статикой: статика означала бы «кто знает путь, тот и
 * читает». Здесь путь бесполезен без подписи, а подпись считается от ключа и
 * срока, поэтому перебором путей ничего не открыть.
 */
@Controller('files')
export class FilesController {
  constructor(
    @Inject(FileStorageService) private readonly storage: FileStorageService,
    @Inject(PdfRepository) private readonly pdfs: PdfRepository,
    @Inject(EventsRepository) private readonly events: EventsRepository,
    @Inject(JsonLogger) private readonly logger: JsonLogger,
  ) {}

  @Get(':scope/:name')
  async serve(
    @Req() request: Request,
    @Res() response: Response,
    @Param('scope') scope: string,
    @Param('name') name: string,
    @Query('sig') signature: string | undefined,
  ): Promise<void> {
    const key = `${scope}/${name}`;

    // Форма ключа — до подписи: `..%2F` в пути это не «файл без подписи», а
    // попытка выйти из каталога, и отвечать на неё `403` значит подтверждать,
    // что за каталогом что-то есть.
    if (!this.storage.isValidKey(key)) {
      this.logger.warn('file_access_denied', { key, reason: 'bad_key' });
      throw notFound(reasonOptions('file_not_found', 'Файл не найден'));
    }

    const verdict = this.storage.verify(key, signature);

    if (verdict !== 'ok') {
      // В лог — причина, но не подпись: она даёт доступ, пока жива.
      this.logger.warn('file_access_denied', { key, reason: verdict });
      throw forbidden(
        reasonOptions(
          verdict === 'expired' ? 'file_link_expired' : 'file_signature_invalid',
          verdict === 'expired'
            ? 'Ссылка на файл устарела — открой его ещё раз'
            : 'Ссылка на файл недействительна',
        ),
      );
    }

    const content = this.storage.contentOf(key);
    const bytes = content === null ? null : await this.storage.read(key);

    if (content === null || bytes === null) {
      // Ссылка валидна, а файла нет: это уже инцидент (потеря хранилища), а не
      // ошибка клиента. Наружу — 404, в лог — факт.
      this.logger.error('file_missing', { key });
      throw notFound(reasonOptions('file_not_found', 'Файл не найден'));
    }

    // Счётчик и событие только у PDF: карточки шеринга — статические картинки,
    // их «скачивание» ничего не значит (Telegram кэширует их у себя).
    if (key.startsWith('pdf/')) {
      void this.countDownload(key, request);
    }

    response.setHeader('content-type', content.contentType);
    // `private` и `no-store`: подписанный адрес не должен осесть в общих кэшах
    // и пережить свой срок.
    response.setHeader('cache-control', 'private, no-store');
    response.setHeader('content-length', String(bytes.byteLength));
    response.end(bytes);
  }

  private async countDownload(key: string, request: Request): Promise<void> {
    try {
      await this.pdfs.markDownloaded(key);
      await this.events.log({
        name: 'pdf_downloaded',
        props: { signed: true, ua_class: userAgentClass(request.header('user-agent')) },
      });
    } catch (error) {
      // Метрика не должна ломать выдачу файла, который человек уже оплатил.
      this.logger.warn('pdf_download_count_failed', {
        key,
        error: error instanceof Error ? error.name : 'unknown',
      });
    }
  }
}

/**
 * Класс клиента вместо самого User-Agent: строка UA — почти отпечаток
 * устройства, а для метрики «скачали из браузера или из бота» хватает класса.
 */
export function userAgentClass(userAgent: string | undefined): 'bot' | 'browser' | 'unknown' {
  if (userAgent === undefined || userAgent === '') {
    return 'unknown';
  }
  return /bot|telegram/i.test(userAgent) ? 'bot' : 'browser';
}
