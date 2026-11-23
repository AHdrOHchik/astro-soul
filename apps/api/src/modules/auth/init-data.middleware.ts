import { Inject, Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { APP_ENV } from '../../config/env.module';
import type { AppEnv } from '../../config/env';
import { forbidden, reasonOptions, unauthorized } from '../../common/api-error';
import { JsonLogger } from '../../common/logger';
import { currentRequestId, requestPath } from '../../common/request-context';
import { sendProblemResponse } from '../../common/problem-response';
import { PresenceService } from '../users/presence.service';
import type { AdminActor, AdminRequest } from '../admin-auth/admin-actor';
import { AdminSessionService } from '../admin-auth/admin-session.service';
import { ADMIN_CSRF_HEADER, clearSessionCookie, readSessionCookie } from '../admin-auth/admin-session-cookie';
import { INIT_DATA_HEADER, verifyInitData, type VerifiedInitData } from './init-data';
import { isPublicPath } from './public-routes';

/** Request с проверенными данными Telegram. */
export interface AuthenticatedRequest extends Request {
  initData: VerifiedInitData;
}

/**
 * Middleware авторизации: любой `/api/v1/*` кроме `/health` требует валидный
 * initData — **кроме админских маршрутов**, у которых с итерации 40 два входа:
 *
 *   1. `Authorization: tma <initData>` (и заголовок `X-Telegram-Init-Data`,
 *      который был раньше и остаётся основным для мини-аппа). Подпись
 *      проверяется на **каждом** запросе, поэтому CSRF здесь не нужен: чужой
 *      сайт не может заставить браузер подписать запрос;
 *   2. cookie `__Host-admin_session` для браузерной панели, плюс заголовок
 *      `X-Admin-CSRF` на изменяющих методах. Cookie уезжает автоматически —
 *      именно поэтому без CSRF её нельзя пускать к `POST`.
 *
 * Оба входа ведут к одному и тому же `req.adminActor`: ручки админки не знают,
 * откуда пришёл человек. Иначе третий способ входа пришлось бы добавлять в
 * каждой ручке отдельно, и однажды он появился бы не везде.
 *
 * Ошибка форматируется здесь же, чтобы не зависеть от того, дошли ли мы до
 * Nest-обработчика.
 */
@Injectable()
export class InitDataMiddleware implements NestMiddleware {
  constructor(
    @Inject(APP_ENV) private readonly env: AppEnv,
    @Inject(JsonLogger) private readonly logger: JsonLogger,
    @Inject(PresenceService) private readonly presence: PresenceService,
    @Inject(AdminSessionService) private readonly sessions: AdminSessionService,
  ) {}

  async use(req: Request, res: Response, next: NextFunction): Promise<void> {
    const path = requestPath(req);

    if (req.method === 'OPTIONS' || isPublicPath(path)) {
      next();
      return;
    }

    if (isAdminPath(path)) {
      try {
        await this.authorizeAdmin(req, res, path, next);
      } catch (error) {
        // Страховка: ни одно исключение гарда не должно остаться без ответа —
        // Express на отклонённый промис middleware ответа не даёт вовсе.
        this.reject(res, path, error);
      }
      return;
    }

    try {
      const verified = verifyInitData(this.initDataHeader(req), this.env.TELEGRAM_BOT_TOKEN);
      (req as AuthenticatedRequest).initData = verified;

      // Присутствие (итерация 38): утренний пуш не приходит тому, кто уже
      // открывал приложение после 07:30 по своему поясу. Запись не ждём —
      // авторизация не должна зависеть от необязательного UPDATE.
      this.presence.touch(verified.telegramUserId);

      next();
    } catch (error) {
      this.reject(res, path, error);
    }
  }

  /**
   * Админские маршруты: cookie-сессия, иначе initData.
   *
   * `POST /admin/auth/logout` — исключение из общего правила и только в двух
   * отношениях: он доступен без авторизации (повторный выход после очищенной
   * cookie обязан вернуть `200`, а не `401`), и активная сессия в нём всё равно
   * требует CSRF: иначе чужой сайт мог бы разлогинить админа одним `<form>`.
   */
  private async authorizeAdmin(
    req: Request,
    res: Response,
    path: string,
    next: NextFunction,
  ): Promise<void> {
    const method = req.method.toUpperCase();
    const mutating = method === 'POST' || method === 'PATCH' || method === 'PUT' || method === 'DELETE';
    const cookie = readSessionCookie(req);

    try {
      if (path === ADMIN_LOGOUT_PATH) {
        const row = cookie === undefined ? null : await this.sessions.findAny(cookie);
        const active =
          row !== null && row.revoked_at === null && row.expires_at.getTime() > Date.now();

        if (row !== null && active) {
          this.assertCsrf(req, row.csrf_token);
          this.attach(req, {
            tgId: BigInt(row.tg_id),
            name: row.name,
            via: 'session',
            sessionId: row.id,
            csrfToken: row.csrf_token,
            expiresAt: row.expires_at,
          });
        }
        next();
        return;
      }

      if (cookie !== undefined) {
        const row = await this.sessions.resolve(cookie);

        if (row === null) {
          // Просроченная или отозванная сессия — это не «нет cookie»: её нужно
          // снять, иначе браузер будет присылать её с каждым запросом и
          // получать `401` без объяснения.
          clearSessionCookie(res, this.secureCookie);
          this.reject(
            res,
            path,
            unauthorized(
              reasonOptions('admin_session_invalid', 'Сессия истекла или отозвана. Войди заново'),
            ),
          );
          return;
        }

        this.assertAdmin(row.tg_id);
        if (mutating) {
          this.assertCsrf(req, row.csrf_token);
        }

        this.attach(req, {
          tgId: BigInt(row.tg_id),
          name: row.name,
          via: 'session',
          sessionId: row.id,
          csrfToken: row.csrf_token,
          expiresAt: row.expires_at,
        });
        next();
        return;
      }

      // Cookie нет — путь мини-аппа: тот же initData, что и везде.
      const verified = verifyInitData(this.initDataHeader(req), this.env.TELEGRAM_BOT_TOKEN);
      (req as AuthenticatedRequest).initData = verified;
      this.attach(req, actorFromInitData(verified));
      this.presence.touch(verified.telegramUserId);
      next();
    } catch (error) {
      // Cookie здесь не снимаем: `csrf_mismatch` — это живая сессия с чужим
      // заголовком, и разлогинивать за это значило бы дать чужому сайту
      // кнопку «выйти». Снимаем только там, где сессия действительно мертва.
      this.reject(res, path, error);
    }
  }

  /**
   * `Authorization: tma <initData>` — штатный способ из документации Telegram,
   * `X-Telegram-Init-Data` — тот, что мы поддерживали до 1.6.15. Оба обязаны
   * работать: мини-апп не должен узнать о контракте из релиз-нот.
   */
  private initDataHeader(req: Request): string | undefined {
    return req.header(INIT_DATA_HEADER) ?? initDataFromAuthorization(req.header('authorization'));
  }

  private get secureCookie(): boolean {
    return this.env.COOKIE_SECURE === 'true';
  }

  /**
   * CSRF: заголовок обязателен и должен совпасть с токеном сессии.
   *
   * Разные тексты для «нет заголовка» и «не тот токен» — не удобство, а
   * диагностика: первое почти всегда означает «фронт забыл заголовок», второе —
   * «сессия перевёрнута в другой вкладке». Оба ответа — `403` до любого эффекта.
   */
  private assertCsrf(req: Request, expected: string): void {
    const header = req.headers[ADMIN_CSRF_HEADER];
    const provided = Array.isArray(header) ? header[0] : header;

    if (typeof provided !== 'string' || provided.trim() === '') {
      throw forbidden(reasonOptions('csrf_missing', 'Нет заголовка X-Admin-CSRF'));
    }

    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(provided.trim(), 'utf8');
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw forbidden(reasonOptions('csrf_mismatch', 'Заголовок X-Admin-CSRF не совпал с сессией'));
    }
  }

  private assertAdmin(tgId: string): void {
    const configured = this.env.ADMIN_TG_ID;
    if (configured === undefined || BigInt(configured) !== BigInt(tgId)) {
      throw forbidden(reasonOptions('admin_only', 'Доступ к панели есть только у владельца'));
    }
  }

  private attach(req: Request, actor: AdminActor): void {
    (req as AdminRequest).adminActor = actor;
  }

  private reject(res: Response, path: string, error: unknown): void {
    this.logger.warn('init_data_rejected', {
      path,
      reason: error instanceof Error ? error.message : String(error),
    });
    sendProblemResponse(res, error, currentRequestId());
  }
}

/**
 * `Authorization: tma <initData>` — разделитель из Telegram (`tma`) и
 * устаревший `Bearer`. Оба варианта означают одно и то же: строка подписи.
 */
export function initDataFromAuthorization(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;
  const match = /^(?:tma|Bearer)\s+(.+)$/i.exec(header.trim());
  return match?.[1];
}

function actorFromInitData(verified: VerifiedInitData): AdminActor {
  const { first_name: first, last_name: last, username } = verified.user;
  const full = [first ?? '', last ?? ''].map((part) => part.trim()).filter((part) => part !== '').join(' ');

  return {
    tgId: verified.telegramUserId,
    name: full !== '' ? full : username ?? verified.telegramUserId.toString(),
    via: 'initData',
    sessionId: null,
    csrfToken: null,
    expiresAt: null,
  };
}

/** Все `/api/v1/admin*` — через один гард. Список не «на глаз»: префикс. */
function isAdminPath(path: string): boolean {
  return path === '/api/v1/admin' || path.startsWith('/api/v1/admin/');
}

const ADMIN_LOGOUT_PATH = '/api/v1/admin/auth/logout';
