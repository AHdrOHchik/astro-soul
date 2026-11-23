import { Inject, Injectable } from '@nestjs/common';
import { ApiError, conflict, forbidden, notFound, reasonOptions } from '../../common/api-error';
import { JsonLogger } from '../../common/logger';
import { splitSentences } from '../../common/sections';
import { APP_ENV } from '../../config/env.module';
import type { AppEnv } from '../../config/env';
import type { VerifiedInitData } from '../auth/init-data';
import { AstroClient } from '../astro/astro.client';
import { AccessService } from '../entitlements/access.service';
import { EventsRepository } from '../events/events.repository';
import { FileStorageService } from '../files/file-storage.service';
import { ReportsRepository, type ReportRow } from '../reports/reports.repository';
import { PROMPT_VERSION } from '../reports/prompts';
import { parseIdempotencyKey } from '../reports/reports.dto';
import { UsersRepository } from '../users/users.repository';
import { PdfRepository, type PdfRow, type PdfStatus } from './pdf.repository';

/** Ответ `POST /reports/{id}/pdf` и `GET /reports/{id}/pdf`. */
export interface PdfStatusView {
  readonly status: PdfStatus;
  readonly url?: string;
  readonly expires_at?: string;
  /** Код причины при `status: "failed"`; при остальных статусах поля нет. */
  readonly error?: string;
}

/** Сколько действий попадает в блок «Что сделать». */
const ACTION_COUNT = 3;
/** Потолок длины одного действия: строка в PDF — не абзац. */
const ACTION_MAX_CHARS = 220;
/** Размер колеса для обложки: печать A4 при 300 dpi не требует больше. */
const COVER_WHEEL_PX = 900;

/**
 * PDF разбора: постановка в очередь, кэш и выдача ссылки.
 *
 * Правила, ради которых сервис выглядит именно так:
 *
 *   1. **`POST` всегда `202`.** Сборка занимает 5–15 секунд; держать HTTP
 *      запрос всё это время — гарантированный таймаут на мобильной сети.
 *      Готовый файл отдаётся сразу (`status: "ready"` и ссылка), новый —
 *      `pending`, клиент опрашивает `GET`.
 *   2. **PDF — часть оплаченного разбора, а не отдельный товар.** Чужой разбор
 *      — `403 report_not_paid` (не 404: человек видит, что разбор существует, но
 *      не его), неготовый — `409 report_not_ready`. Собирать документ по
 *      тизеру нельзя: в нём был бы огрызок текста.
 *   3. **Повтор не пересобирает файл.** Кэш по
 *      `(report_id, engine_version, prompt_version)`; второй `POST` отдаёт уже
 *      собранный документ и не зовёт сайдкар.
 *   4. **Ссылка подписанная и короткоживущая.** Публичного адреса у файла нет;
 *      каждый `GET` возвращает свежую подпись на 24 часа.
 *   5. **`Idempotency-Key` обязателен и на PDF.** Не ради денег (сборка —
 *      CPU, а не токены), а ради сайдкара: двойной тап по кнопке не должен
 *      ставить две сборки на один разбор.
 */
@Injectable()
export class PdfService {
  constructor(
    @Inject(ReportsRepository) private readonly reports: ReportsRepository,
    @Inject(PdfRepository) private readonly repo: PdfRepository,
    @Inject(FileStorageService) private readonly storage: FileStorageService,
    @Inject(AstroClient) private readonly astro: AstroClient,
    @Inject(AccessService) private readonly access: AccessService,
    @Inject(EventsRepository) private readonly events: EventsRepository,
    @Inject(UsersRepository) private readonly users: UsersRepository,
    @Inject(APP_ENV) private readonly env: AppEnv,
    @Inject(JsonLogger) private readonly logger: JsonLogger,
  ) {}

  /** `POST /reports/{id}/pdf` — `202` в любом случае. */
  async request(
    auth: VerifiedInitData,
    reportId: string,
    idempotencyHeader?: string,
  ): Promise<PdfStatusView> {
    parseIdempotencyKey(idempotencyHeader);
    const report = await this.ownReport(auth, reportId);

    const existing = await this.repo.find(report.id, this.env.ENGINE_VERSION, PROMPT_VERSION);

    if (existing !== null && existing.status === 'ready' && existing.storage_key !== null) {
      // Кэш: файл уже есть, второй сборки не будет.
      return this.readyView(existing);
    }

    if (existing !== null && existing.status === 'pending') {
      // Сборка уже идёт: второй процесс над тем же разбором не запускаем.
      return { status: 'pending' };
    }

    if (existing !== null && existing.status === 'failed') {
      // Повтор разрешён: `failed` — это «не получилось», а не «нельзя».
      const retried = await this.repo.retry(existing.id);
      if (retried !== null) {
        void this.build(report, retried.id);
        return { status: 'pending' };
      }
    }

    const claimed = await this.claimSlot(report);

    if (!claimed.created && claimed.row.status === 'ready' && claimed.row.storage_key !== null) {
      return this.readyView(claimed.row);
    }

    if (claimed.created) {
      // Сборка — в фоне: ответ уже ушёл, ошибки живут в строке и в логах.
      void this.build(report, claimed.row.id);
    }

    return { status: claimed.row.status === 'ready' ? 'ready' : 'pending' };
  }

  /**
   * Занять слот сборки или честно сказать, что очередь недоступна.
   *
   * `503 pdf_failed` остаётся ровно за этим случаем: провал **самой** сборки
   * живёт в теле как `status: "failed"` (ответ уже ушёл, `GET` покажет
   * `error`), а вот «не удалось даже поставить в очередь» — это отказ
   * сервиса, и клиент должен увидеть ошибку, а не вечный `pending`.
   */
  private async claimSlot(report: ReportRow): Promise<{ row: PdfRow; created: boolean }> {
    try {
      return await this.repo.claim(
        report.id,
        report.user_id,
        this.env.ENGINE_VERSION,
        PROMPT_VERSION,
      );
    } catch (error) {
      this.logger.error('pdf_claim_failed', {
        report_id: report.id,
        error: error instanceof Error ? error.message : 'unknown',
      });

      throw new ApiError(
        'INTERNAL',
        503,
        reasonOptions('pdf_failed', 'Не удалось поставить сборку PDF в очередь — попробуй ещё раз'),
      );
    }
  }

  /** `GET /reports/{id}/pdf` — статус и свежая ссылка. */
  async status(auth: VerifiedInitData, reportId: string): Promise<PdfStatusView> {
    const report = await this.ownReport(auth, reportId);
    const row = await this.repo.find(report.id, this.env.ENGINE_VERSION, PROMPT_VERSION);

    if (row === null) {
      // Ещё не просили собрать: статус `pending` здесь означал бы «идёт
      // сборка», которой нет. Отвечаем `pending` только про реальную строку,
      // а «не начинали» — это тоже `pending` по контракту, но без ссылки.
      return { status: 'pending' };
    }

    if (row.status === 'ready' && row.storage_key !== null) {
      return this.readyView(row);
    }

    if (row.status === 'failed') {
      return { status: 'failed', error: row.error_code ?? 'pdf_failed' };
    }

    return { status: 'pending' };
  }

  /**
   * Разбор, который человек вправе экспортировать.
   *
   * `403` на чужой разбор, а не `404`: разбор существует и человек его видит в
   * своём списке заказов — «не найдено» здесь означало бы, что мы потеряли
   * заказ. PDF доступен только по готовому разбору: `ready` — это и есть
   * подтверждение оплаты (заказ создаётся лишь после проверки права).
   */
  private async ownReport(auth: VerifiedInitData, reportId: string): Promise<ReportRow> {
    const userId = this.users.userIdFor(auth.telegramUserId);
    const report = await this.reports.byId(reportId);

    if (report === null) {
      throw notFound(reasonOptions('report_not_found', 'Такого разбора нет'));
    }

    if (report.user_id !== userId) {
      throw forbidden(reasonOptions('report_not_paid', 'PDF — часть оплаченного разбора'));
    }

    if (report.status !== 'ready' || (report.chapters ?? []).length === 0) {
      // Тизер и разбор «в процессе» неразличимы для экспорта: в обоих нет
      // текста. `409`, а не `403`: право есть, текста пока нет — повтори позже.
      throw conflict(
        reasonOptions(
          'report_not_ready',
          'Разбор ещё собирается — PDF можно будет скачать, когда текст готов',
        ),
      );
    }

    // Право на PDF — это право на разбор по этой карте, а не просто `ready`:
    // тизер тоже бывает `ready`, но текста для документа в нём нет.
    //
    // Спрашиваем `AccessService`, а не `entitlements` напрямую (1.6.14):
    // бесплатный разбор по коду или от основателя материализуется в
    // `entitlements` при списании, но если однажды появится ещё один источник
    // прав, он должен подключиться внутри `hasAccess`, а не в PDF.
    const owned = await this.access.hasAccess(userId, 'report', { chartId: report.chart_id });
    if (!owned) {
      throw forbidden(reasonOptions('report_not_paid', 'PDF — часть оплаченного разбора'));
    }

    return report;
  }

  private readyView(row: PdfRow): PdfStatusView {
    const key = row.storage_key;
    if (key === null) {
      return { status: 'pending' };
    }

    const signed = this.storage.signedUrl(key);

    return { status: 'ready', url: signed.url, expires_at: signed.expires_at };
  }

  /**
   * Сборка в фоне. Ни одна ошибка наружу не пробрасывается: ответ уже отдан,
   * а факт провала виден в `GET` (`failed`) и в метрике `pdf_failed_24h`.
   */
  private async build(report: ReportRow, rowId: string): Promise<void> {
    const started = Date.now();

    try {
      const chart = await this.repo.chartData(report.chart_id);
      if (chart === null) {
        throw new ApiError('INTERNAL', 503, { reason: 'chart_missing' });
      }

      const wheel = await this.astro.wheelPng(chart, 'light', COVER_WHEEL_PX);
      const chapters = this.chaptersOf(report);
      const built = await this.astro.buildPdf({
        subtitle: `Собрано ${formatRuDate(new Date())}`,
        chapters,
        actions: this.actionsOf(report),
        link: this.linkOf(),
        wheel_png_base64: wheel.toString('base64'),
        max_bytes: this.env.PDF_MAX_BYTES,
      });

      const pdf = Buffer.from(built.pdf_base64, 'base64');
      const stored = await this.storage.put('pdf', pdf);

      await this.repo.markReady(rowId, {
        storageKey: stored.key,
        bytes: stored.bytes,
        pages: built.pages,
        buildMs: built.build_ms,
      });

      await this.events.log({
        name: 'pdf_ready',
        props: {
          bytes: stored.bytes,
          pages: built.pages,
          build_ms: built.build_ms,
          wheel_scale: built.wheel_scale,
        },
      });

      this.logger.info('pdf_ready', {
        report_id: report.id,
        bytes: stored.bytes,
        pages: built.pages,
        build_ms: built.build_ms,
        total_ms: Date.now() - started,
      });
    } catch (error) {
      const code = errorCodeOf(error);
      await this.repo.markFailed(rowId, code);
      this.logger.error('pdf_failed', {
        report_id: report.id,
        code,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Главы в серверном порядке. `body_md` → абзацы, без markdown-разметки. */
  private chaptersOf(report: ReportRow): { title: string; paragraphs: string[] }[] {
    const chapters = [...(report.chapters ?? [])].sort((left, right) => left.order - right.order);

    return chapters.map((chapter) => ({
      title: chapter.title,
      paragraphs: chapter.body_md
        .split(/\n{2,}/u)
        .map((paragraph) => paragraph.replace(/\s+/gu, ' ').trim())
        .filter((paragraph) => paragraph !== ''),
    }));
  }

  /**
   * Три действия для финального блока.
   *
   * Отдельного структурированного списка действий в разборе нет (в контракте
   * его не было), а придумывать новое поле в этой итерации нельзя. Берём
   * последние предложения главы «Итог: что с этим делать» — она ровно про это
   * и написана. Если главы нет (частичный разбор) — блока не будет вовсе:
   * пустой заголовок «Что сделать» хуже его отсутствия.
   */
  private actionsOf(report: ReportRow): string[] {
    const chapters = report.chapters ?? [];
    const summary = chapters.find((chapter) => chapter.key === 'summary') ?? null;
    if (summary === null) {
      return [];
    }

    const sentences = splitSentences(summary.body_md)
      .map((sentence) => sentence.trim())
      .filter((sentence) => sentence.length > 20 && sentence.length <= ACTION_MAX_CHARS);

    return sentences.slice(-ACTION_COUNT);
  }

  private linkOf(): string | null {
    const bot = this.env.BOT_USERNAME;
    return bot === undefined ? null : `t.me/${bot}`;
  }
}

function errorCodeOf(error: unknown): string {
  if (error instanceof ApiError) {
    const reason = (error.details as { reason?: string } | undefined)?.reason;
    if (reason === 'chart_missing') {
      return 'pdf_failed';
    }
    return 'astro_unavailable';
  }

  return 'pdf_failed';
}

const RU_MONTHS = [
  'января',
  'февраля',
  'марта',
  'апреля',
  'мая',
  'июня',
  'июля',
  'августа',
  'сентября',
  'октября',
  'ноября',
  'декабря',
] as const;

/** «Собрано 20 ноября 2026»: дата сборки, а не дата рождения. */
export function formatRuDate(date: Date): string {
  return `${String(date.getUTCDate())} ${RU_MONTHS[date.getUTCMonth()] ?? ''} ${String(date.getUTCFullYear())}`;
}
