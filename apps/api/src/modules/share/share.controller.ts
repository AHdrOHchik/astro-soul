import { Body, Controller, HttpCode, Inject, Post } from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator';
import type { VerifiedInitData } from '../auth/init-data';
import { ShareService, type ShareCardView } from './share.service';

/**
 * Карточка для шеринга (контракт 1.6.8).
 *
 * `200`, а не `201`: карточка кэшируется по содержимому, и в большинстве
 * запросов ничего не создаётся — мы отдаём ссылку на уже готовый файл.
 */
@Controller('share')
export class ShareController {
  constructor(@Inject(ShareService) private readonly share: ShareService) {}

  @Post('card')
  @HttpCode(200)
  async card(
    @CurrentUser() auth: VerifiedInitData,
    @Body() body: unknown,
  ): Promise<ShareCardView> {
    return this.share.card(auth, body);
  }
}
