import { Inject, Injectable } from '@nestjs/common';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, normalize, resolve, sep } from 'node:path';
import { APP_ENV } from '../../config/env.module';
import type { AppEnv } from '../../config/env';
import { ApiError, reasonOptions } from '../../common/api-error';
import { JsonLogger } from '../../common/logger';

/** Форма ключа: два разрешённых скоупа и только безопасные символы имени. */
const KEY_PATTERN = /^(pdf|card)\/[A-Za-z0-9._-]+\.(pdf|png)$/u;

/** Что за файл: от этого зависит расширение, content-type и каталог. */
export type FileScope = 'pdf' | 'card';

const EXTENSIONS: Readonly<Record<FileScope, string>> = {
  pdf: 'pdf',
  card: 'png',
};

/** Расширение → content-type. Только то, что мы умеем отдавать. */
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  pdf: 'application/pdf',
  png: 'image/png',
};

export interface SignedFileUrl {
  /** Абсолютный адрес, если задан `PUBLIC_API_URL`, иначе относительный. */
  readonly url: string;
  readonly expires_at: string;
}

export interface StoredFile {
  readonly key: string;
  readonly bytes: number;
}

/**
 * Приватное хранилище файлов и подписанные ссылки на них.
 *
 * Три правила, из которых выросла эта реализация:
 *
 *   1. **Публичных файлов нет.** Каталог не отдаётся статикой; единственный
 *      вход — `GET /api/v1/files/{key}` с подписью и сроком. Утечка ключа из
 *      БД (или лога) доступа не даёт: без подписи маршрут отвечает 403.
 *   2. **Подпись на нашем домене.** В ответах API и в боте нет ни S3-URL, ни
 *      путей хранилища — только адрес нашего API с `exp` и `sig`.
 *   3. **Срок короткий и обязательный.** `expires_at` — часть подписи, поэтому
 *      «продлить» ссылку правкой query нельзя: подпись перестанет сходиться.
 *
 * Ключ файла — `pdf/<uuid>.pdf` или `card/<uuid>.png`. Имя генерируется
 * сервером (uuid), а не берётся из запроса; при чтении ключ нормализуется и
 * проверяется на выход за пределы каталога — иначе `../` в пути читал бы
 * чужие файлы.
 */
@Injectable()
export class FileStorageService {
  private readonly root: string;
  private readonly secret: string;
  readonly ttlSeconds: number;

  constructor(
    @Inject(APP_ENV) private readonly env: AppEnv,
    @Inject(JsonLogger) private readonly logger: JsonLogger,
  ) {
    this.root = resolve(env.FILE_STORAGE_DIR);
    this.secret = env.FILE_SIGNING_SECRET ?? `file-signing:${env.PSEUDONYM_PEPPER}`;
    this.ttlSeconds = env.FILE_URL_TTL_SECONDS;
  }

  /**
   * Похож ли ключ на наш: `pdf/<uuid>.pdf` или `card/<uuid>.png`.
   *
   * Проверка стоит **до** подписи: ключ приходит из URL, и `..%2F` в нём — это
   * попытка выйти из каталога, а не «файл без подписи». Отвечаем `404`, чтобы
   * не подтверждать существование чего-либо за пределами хранилища.
   */
  isValidKey(key: string): boolean {
    return KEY_PATTERN.test(key) && normalize(key).split(sep).join('/') === key;
  }

  /** Каталог хранилища — для тестов и диагностики. */
  get directory(): string {
    return this.root;
  }

  /** Сохраняет байты и возвращает ключ. Имя генерируется здесь, не клиентом. */
  async put(scope: FileScope, bytes: Buffer): Promise<StoredFile> {
    const key = `${scope}/${randomUUID()}.${EXTENSIONS[scope]}`;
    const path = this.pathOf(key);

    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);

    return { key, bytes: bytes.byteLength };
  }

  /** Читает файл. Нет файла — `null`: вызывающий сам решает, это 404 или 410. */
  async read(key: string): Promise<Buffer | null> {
    try {
      return await readFile(this.pathOf(key));
    } catch {
      return null;
    }
  }

  /**
   * Удаляет файл. Ошибка не бросается: `DELETE /me` не должен падать из-за
   * того, что файла уже нет (или каталог размонтирован) — строка в БД всё
   * равно удаляется, а факт пишется в лог.
   */
  async remove(key: string): Promise<boolean> {
    try {
      await rm(this.pathOf(key), { force: true });
      return true;
    } catch (error) {
      this.logger.warn('file_remove_failed', {
        key,
        error: error instanceof Error ? error.name : 'unknown',
      });
      return false;
    }
  }

  async removeMany(keys: readonly string[]): Promise<number> {
    let removed = 0;
    for (const key of keys) {
      if (await this.remove(key)) {
        removed += 1;
      }
    }
    return removed;
  }

  /**
   * Свежая подписанная ссылка. Каждый вызов — новый срок, старая ссылка
   * протухает: так задумано, а не «недосмотр».
   *
   * Формат подписи тот же, что у колеса (`<expires>.<hmac>`), — в проекте один
   * способ подписывать публичные адреса, и второй означал бы вторую ошибку.
   */
  signedUrl(key: string, ttlSeconds = this.ttlSeconds, now: Date = new Date()): SignedFileUrl {
    const expires = Math.floor(now.getTime() / 1000) + ttlSeconds;
    const path = `/api/v1/files/${key}?sig=${encodeURIComponent(this.sign(key, expires))}`;
    const base = this.env.PUBLIC_API_URL;

    return {
      url: base === undefined ? path : `${base.replace(/\/$/u, '')}${path}`,
      expires_at: new Date(expires * 1000).toISOString(),
    };
  }

  /**
   * Проверка подписи и срока. Возвращает причину отказа, а не просто `false`:
   * «протухло» и «подделано» — разные инциденты, и в логе они должны
   * отличаться (одно лечится повторным запросом, другое — нет).
   */
  verify(key: string, signature: string | undefined, now: Date = new Date()):
    | 'ok'
    | 'bad_signature'
    | 'expired' {
    if (signature === undefined) {
      return 'bad_signature';
    }

    const [expiresRaw, mac] = signature.split('.');
    if (expiresRaw === undefined || mac === undefined || mac === '' || !/^\d+$/u.test(expiresRaw)) {
      return 'bad_signature';
    }

    const expires = Number(expiresRaw);
    // Сравниваем подпись целиком (`<exp>.<mac>`), а не только `mac`: срок —
    // часть подписи, иначе `exp` можно было бы поднять правкой query.
    const expected = Buffer.from(this.sign(key, expires));
    const provided = Buffer.from(signature);

    // Сравнение с постоянным временем: подпись — это фактически пароль.
    if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
      return 'bad_signature';
    }

    return expires * 1000 <= now.getTime() ? 'expired' : 'ok';
  }

  contentOf(key: string): { contentType: string; inline: boolean } | null {
    const extension = key.split('.').pop() ?? '';
    const contentType = CONTENT_TYPES[extension];

    return contentType === undefined ? null : { contentType, inline: true };
  }

  /** `<expires>.<hmac>` — срок внутри подписи, продлить правкой URL нельзя. */
  private sign(key: string, expires: number): string {
    const mac = createHmac('sha256', this.secret)
      .update(`${key}:${String(expires)}`)
      .digest('base64url');

    return `${String(expires)}.${mac}`;
  }

  /**
   * Ключ → абсолютный путь. Всё, что выходит за каталог хранилища, — ошибка
   * клиента: ключи приходят из URL, и `..%2F` в них быть не должно.
   */
  private pathOf(key: string): string {
    if (!this.isValidKey(key)) {
      throw new ApiError('NOT_FOUND', 404, reasonOptions('file_not_found', 'Файл не найден'));
    }

    const normalised = normalize(key).split(sep).join('/');
    if (normalised !== key) {
      throw new ApiError('NOT_FOUND', 404, reasonOptions('file_not_found', 'Файл не найден'));
    }

    return join(this.root, key);
  }
}
