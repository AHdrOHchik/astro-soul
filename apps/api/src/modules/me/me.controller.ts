import { Body, Controller, Delete, Get, HttpCode, Inject, Post, Query } from '@nestjs/common';
import type { Me, Notifications } from '@astro-soul/shared';
import { CurrentUser } from '../auth/current-user.decorator';
import type { VerifiedInitData } from '../auth/init-data';
import { MeService } from './me.service';

@Controller('me')
export class MeController {
  constructor(@Inject(MeService) private readonly meService: MeService) {}

  /**
   * `GET /me` (контракт 1.6.14) — параметр `start` несёт `pt_<code>` или
   * `ref_<short>`: Telegram отдаёт его мини-аппу, а бот — текстом. Всё
   * остальное игнорируется, поэтому незнакомый `start` не роняет `/me`.
   */
  @Get()
  async getMe(
    @CurrentUser() auth: VerifiedInitData,
    @Query('start') start?: string,
  ): Promise<Me> {
    return this.meService.getMe(auth, start === undefined ? {} : { start });
  }

  /**
   * `POST /me/notifications` (контракт 1.6.11) — согласия на уведомления.
   * Тело заменяет состояние целиком; ответ — та же форма, что `Me.notifications`.
   */
  @Post('notifications')
  @HttpCode(200)
  async setNotifications(
    @CurrentUser() auth: VerifiedInitData,
    @Body() body: unknown,
  ): Promise<Notifications> {
    return this.meService.setNotifications(auth, body);
  }

  /** Полное удаление ПДн. 409 — если есть незавершённая оплата. */
  @Delete()
  @HttpCode(204)
  async deleteMe(@CurrentUser() auth: VerifiedInitData): Promise<void> {
    await this.meService.deleteMe(auth);
  }
}
