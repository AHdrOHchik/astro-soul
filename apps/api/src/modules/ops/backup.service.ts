import { Inject, Injectable } from '@nestjs/common';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { APP_ENV } from '../../config/env.module';
import type { AppEnv } from '../../config/env';
import { JsonLogger } from '../../common/logger';

/**
 * Бэкап «по кнопке» из панели (контракт 1.6.17).
 *
 * **Тот же путь, что cron.** Сервис не переписывает `scripts/db-dump.sh` на
 * TypeScript, а запускает его как дочерний процесс: порядок «локальный файл →
 * выгрузка → файл-маркер» живёт в одном месте, и кнопка в панели не может
 * сделать его иначе, чем ночной cron. Вторая реализация того же дампа рано или
 * поздно разошлась бы с первой — и разошлась бы именно в порядке шагов, то есть
 * в том, что делает бэкап бэкапом.
 *
 * Что сервис проверяет **до** запуска:
 *   • выгрузка настроена (`BACKUP_S3_URL` или `BACKUP_REMOTE`) и есть
 *     `BACKUP_STATE_FILE`. Локальная копия без выгрузки — не бэкап (она умирает
 *     вместе с диском), поэтому «не настроено» — это `503`, а не «сделалось».
 *     Панель должна показать «не настроено», а не «делается»;
 *   • скрипт существует (иначе `503`, а не «запустили и забыли»);
 *   • не идёт ли уже дамп и не запускали ли его меньше 10 минут назад — `409`.
 *
 * Почему 10 минут. Два одновременных `pg_dump` делят диск и канал выгрузки, а
 * повторное нажатие «сделать бэкап» через минуту после успешного — это всегда
 * «не увидел, что уже сделано». Ограничение живёт в памяти процесса: при
 * нескольких инстансах API защищает уже сам cron (файл-маркер и `flock` в
 * скрипте), а здесь важно не дать нажать кнопку дважды в одной панели.
 */
export interface BackupConfig {
  readonly configured: boolean;
  /** Чего не хватает — имена переменных, без значений (секретов в ответе нет). */
  readonly missing: readonly string[];
  /** Абсолютный путь к скрипту; `null` — скрипта нет. */
  readonly script: string | null;
}

export type BackupStartOutcome =
  | { readonly kind: 'started'; readonly jobId: string }
  | { readonly kind: 'not_configured'; readonly missing: readonly string[] }
  | { readonly kind: 'in_progress'; readonly retryAfterSeconds: number }
  | { readonly kind: 'too_frequent'; readonly retryAfterSeconds: number };

/** Интервал между запусками из панели: одно нажатие в 10 минут. */
export const BACKUP_MIN_INTERVAL_MS = 10 * 60 * 1000;

/**
 * Что значит `retry_after_seconds` у `backup_in_progress` (1.6.18).
 *
 * У `too_frequent` это точный остаток окна — там срок известен. У идущего
 * дампа срок неизвестен никому: `pg_dump` и выгрузка занимают сколько
 * занимают, таймаута у скрипта нет, и любое «осталось N секунд» было бы
 * выдумкой. Поэтому здесь это **интервал опроса**: панель гасит кнопку на
 * полминуты и спрашивает снова. Не ноль — иначе панель опрашивала бы в цикле,
 * не единица — это тот же цикл, только с лишними запросами.
 */
export const BACKUP_IN_PROGRESS_RETRY_SECONDS = 30;

@Injectable()
export class BackupService {
  constructor(
    @Inject(APP_ENV) private readonly env: AppEnv,
    @Inject(JsonLogger) private readonly logger: JsonLogger,
  ) {}

  private running: string | null = null;
  private lastStartedAt: Date | null = null;

  /**
   * Часы. Свойство, а не `new Date()` внутри: тест «прошло меньше 10 минут» и
   * «прошло больше» не должен ждать десять минут (тот же приём, что в
   * `CodeActivationThrottle`).
   */
  now: () => Date = () => new Date();

  /**
   * Сброс ограничителей. Нужен тестам между случаями (сервис — синглтон
   * приложения, и «10 минут» одного теста иначе видны следующему) и человеку
   * после ручного вмешательства: если процесс перезапустили посреди дампа,
   * `running` в памяти уже пуст, а «не чаще раза в 10 минут» переживать
   * перезапуск не обязано.
   */
  reset(): void {
    this.running = null;
    this.lastStartedAt = null;
  }

  /** Можно ли запускать бэкап из панели и чего не хватает, если нельзя. */
  config(): BackupConfig {
    const missing: string[] = [];

    if (this.env.BACKUP_STATE_FILE === undefined) {
      missing.push('BACKUP_STATE_FILE');
    }

    if (this.env.BACKUP_S3_URL === undefined && this.env.BACKUP_REMOTE === undefined) {
      missing.push('BACKUP_S3_URL', 'BACKUP_REMOTE');
    }

    const script = this.scriptPath();

    if (script === null) {
      missing.push('BACKUP_SCRIPT');
    }

    return { configured: missing.length === 0, missing, script };
  }

  /** Идёт ли дамп прямо сейчас (для `409 backup_in_progress` и логов). */
  isRunning(): boolean {
    return this.running !== null;
  }

  /**
   * Запуск. Возвращается сразу: `202` не ждёт `pg_dump` (он идёт минуты, и
   * держать HTTP-запрос всё это время — значит получить таймаут панели).
   */
  start(now: Date = this.now()): BackupStartOutcome {
    const config = this.config();

    if (!config.configured || config.script === null) {
      return { kind: 'not_configured', missing: config.missing };
    }

    if (this.running !== null) {
      return { kind: 'in_progress', retryAfterSeconds: BACKUP_IN_PROGRESS_RETRY_SECONDS };
    }

    if (this.lastStartedAt !== null) {
      const elapsed = now.getTime() - this.lastStartedAt.getTime();

      if (elapsed < BACKUP_MIN_INTERVAL_MS) {
        return {
          kind: 'too_frequent',
          retryAfterSeconds: Math.ceil((BACKUP_MIN_INTERVAL_MS - elapsed) / 1000),
        };
      }
    }

    const jobId = randomUUID();
    this.running = jobId;
    this.lastStartedAt = now;

    const child = spawn('bash', [config.script], {
      // Скрипт читает настройки из окружения — ровно те же имена, что в cron.
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    child.on('error', (error: Error) => {
      this.running = null;
      this.logger.error('backup_run_failed', { job_id: jobId, error: error.message });
    });

    child.on('exit', (code) => {
      this.running = null;

      if (code === 0) {
        // Маркер пишет сам скрипт — после выгрузки. Здесь только лог.
        this.logger.info('backup_run_finished', { job_id: jobId, exit_code: code });
        return;
      }

      this.logger.error('backup_run_failed', {
        job_id: jobId,
        exit_code: code,
        // Последняя строка stderr: там у скрипта код причины (`FAILED (5): …`).
        stderr: stderr.trim().split('\n').slice(-1)[0] ?? null,
      });
    });

    // Родитель не должен держать процесс живым после остановки API: дамп уже
    // идёт, а его завершение логирует обработчик `exit`, если процесс жив.
    child.unref();

    return { kind: 'started', jobId };
  }

  /**
   * Путь к скрипту: `BACKUP_SCRIPT` или штатный `scripts/db-dump.sh`.
   *
   * Скрипт ищется от `cwd` вверх на два уровня: API запускается и из корня
   * монорепо (прод), и из `apps/api` (тесты и `pnpm dev`), и «не найден» не
   * должно превращаться в «бэкап не настроен» без объяснения.
   */
  private scriptPath(): string | null {
    const configured = this.env.BACKUP_SCRIPT;

    if (configured !== undefined) {
      return existsSync(configured) ? resolve(configured) : null;
    }

    for (const candidate of [
      resolve(process.cwd(), 'scripts/db-dump.sh'),
      resolve(process.cwd(), '..', '..', 'scripts/db-dump.sh'),
    ]) {
      if (existsSync(candidate)) {
        return candidate;
      }
    }

    return null;
  }
}
