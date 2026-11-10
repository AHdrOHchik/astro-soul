import { Inject, Injectable } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { APP_ENV } from '../../config/env.module';
import type { AppEnv } from '../../config/env';

/** Срок жизни подписанной ссылки на колесо: картинку шарят в чатах. */
export const WHEEL_URL_TTL_SECONDS = 30 * 24 * 60 * 60;

const SIGNATURE_CONTEXT = 'wheel-url:v1';

/**
 * Подпись ссылки на SVG-колесо (`?sig=`).
 *
 * Колесо доступно без initData (контракт: `security: []`), поэтому право на
 * картинку даёт HMAC, а не сессия. Ключ выводится из `PSEUDONYM_PEPPER` с
 * отдельной меткой, чтобы подпись нельзя было переиспользовать в другом месте.
 */
@Injectable()
export class WheelSignatureService {
  private readonly secret: Buffer;

  constructor(@Inject(APP_ENV) env: AppEnv) {
    this.secret = createHmac('sha256', env.PSEUDONYM_PEPPER).update(SIGNATURE_CONTEXT).digest();
  }

  sign(chartId: string, ttlSeconds: number = WHEEL_URL_TTL_SECONDS, now = Date.now()): string {
    const expiresAt = Math.floor(now / 1000) + ttlSeconds;
    return `${expiresAt}.${this.mac(chartId, expiresAt)}`;
  }

  /** Проверка подписи и срока; сравнение — timing-safe. */
  verify(chartId: string, signature: string | undefined, now = Date.now()): boolean {
    if (signature === undefined) {
      return false;
    }

    const [expiresAtRaw, macRaw] = signature.split('.');
    if (expiresAtRaw === undefined || macRaw === undefined) {
      return false;
    }

    const expiresAt = Number(expiresAtRaw);
    if (!Number.isInteger(expiresAt) || expiresAt * 1000 <= now) {
      return false;
    }

    const expected = Buffer.from(this.mac(chartId, expiresAt), 'utf8');
    const provided = Buffer.from(macRaw, 'utf8');

    return expected.length === provided.length && timingSafeEqual(expected, provided);
  }

  private mac(chartId: string, expiresAt: number): string {
    return createHmac('sha256', this.secret)
      .update(`${chartId}:${expiresAt}`)
      .digest('base64url');
  }
}
