import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { forbidden, reasonOptions, unauthorized } from '../../common/api-error';

/**
 * Кто именно действует в админке. Один тип на оба входа: строка `initData` из
 * мини-аппа (`via: 'initData'`, без CSRF — подпись проверяется на каждом
 * запросе) и cookie-сессия панели (`via: 'session'`, CSRF обязателен на
 * изменяющих методах).
 *
 * Ручки админки не различают эти пути: им нужен `tgId` для проверки
 * `ADMIN_TG_ID` и имя для аудита. Если бы каждый маршрут знал про два способа
 * входа, третий способ однажды появился бы в одном месте из пяти.
 */
export interface AdminActor {
  readonly tgId: bigint;
  /** Снимок имени: для сессии — из строки входа, для initData — из Telegram. */
  readonly name: string;
  readonly via: 'initData' | 'session';
  /** `admin_sessions.id` для cookie-пути; `null` — вход по initData. */
  readonly sessionId: string | null;
  /** CSRF-токен сессии; `null` у входа по initData (там подпись на каждом запросе). */
  readonly csrfToken: string | null;
  /** Срок сессии для `GET /admin/me`; `null` у входа по initData. */
  readonly expiresAt: Date | null;
}

/**
 * Единственная проверка «это владелец». `ADMIN_TG_ID` не задан — закрыто для
 * всех: «нет настройки» не должно означать «открыто всем».
 */
export function isAdmin(actor: AdminActor, adminTgId: number | undefined): boolean {
  return adminTgId !== undefined && BigInt(adminTgId) === actor.tgId;
}

export function assertAdmin(actor: AdminActor, adminTgId: number | undefined): void {
  if (!isAdmin(actor, adminTgId)) {
    throw forbidden(reasonOptions('admin_only', 'Доступ к панели есть только у владельца'));
  }
}

export interface AdminRequest extends Request {
  adminActor?: AdminActor;
}

export function adminActorOf(request: Request): AdminActor | undefined {
  return (request as AdminRequest).adminActor;
}

/**
 * `@CurrentAdmin()` — единственный способ получить действующего админа.
 *
 * `undefined` — ошибка программиста (маршрут не под гардом), и отвечать на неё
 * надо `401`, а не «неизвестный админ с tgId 0»: нулевой идентификатор прошёл
 * бы проверку на равенство только если `ADMIN_TG_ID` не настроен, то есть
 * открыл бы админку конфигурационной ошибкой.
 */
export const CurrentAdmin = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AdminActor => {
    const request = context.switchToHttp().getRequest<Request>();
    const actor = adminActorOf(request);
    if (actor === undefined) {
      throw unauthorized(reasonOptions('admin_actor_missing'));
    }
    return actor;
  },
);
