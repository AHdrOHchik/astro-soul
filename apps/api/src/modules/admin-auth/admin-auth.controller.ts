import { Body, Controller, Get, HttpCode, Inject, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { validationFailed, reasonOptions } from '../../common/api-error';
import { APP_ENV } from '../../config/env.module';
import type { AppEnv } from '../../config/env';
import { CurrentAdmin, type AdminActor } from './admin-actor';
import { AdminSessionService, type AdminMeResponse } from './admin-session.service';
import { clearSessionCookie, readSessionCookie, setSessionCookie } from './admin-session-cookie';

/**
 * Вход, «кто я» и выход для админ-панели (контракт 1.6.15).
 *
 * `GET /admin/me` отдаёт `csrf_token` — не потому, что это удобно, а потому что
 * у панели нет другого способа получить его: cookie `HttpOnly`, JS её не
 * прочитает. Срок в ответе — подсказка для UI; **источник правды — `401`**:
 * панель не продлевает сессию по своим часам.
 */

interface OkResponse {
  readonly ok: true;
}

@Controller('admin')
export class AdminAuthController {
  constructor(
    @Inject(AdminSessionService) private readonly sessions: AdminSessionService,
    @Inject(APP_ENV) private readonly env: AppEnv,
  ) {}

  /**
   * Вход по подписи Telegram Login Widget.
   *
   * Тело — «как есть» из виджета (все поля, включая `hash`), а не разобранный
   * DTO: набор полей задаёт Telegram, и жёсткая схема сломалась бы на первом же
   * добавленном поле. Что тело объект, а не массив/строка, проверяем здесь.
   */
  @Post('auth/telegram')
  @HttpCode(200)
  async telegram(
    @Body() body: unknown,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<OkResponse> {
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw validationFailed(reasonOptions('malformed', 'Ожидается объект с полями Telegram'));
    }

    const { session, ttlSeconds } = await this.sessions.login({
      fields: body as Readonly<Record<string, unknown>>,
      ip: request.ip,
    });

    setSessionCookie(response, session.id, ttlSeconds, this.env.COOKIE_SECURE === 'true');
    return { ok: true };
  }

  /**
   * Кто вошёл. Для cookie-пути — из строки сессии (`name` — снимок), для
   * initData-пути срок и CSRF отсутствуют: там подпись проверяется на каждом
   * запросе, и токен не нужен (в контракте оба поля nullable).
   */
  @Get('me')
  me(@CurrentAdmin() actor: AdminActor): AdminMeResponse {
    return this.sessions.me(actor);
  }

  /**
   * Выход. Идемпотентен: сессия отзывается (`revoked_at`), cookie снимается,
   * повторный вызов — снова `200`. Иначе кнопка «Выйти», нажатая дважды,
   * показывала бы ошибку на успешном действии.
   */
  @Post('auth/logout')
  @HttpCode(200)
  async logout(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<OkResponse> {
    await this.sessions.logout(readSessionCookie(request));
    clearSessionCookie(response, this.env.COOKIE_SECURE === 'true');
    return { ok: true };
  }
}
