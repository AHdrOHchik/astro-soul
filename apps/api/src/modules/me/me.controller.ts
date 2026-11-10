import { Controller, Get, Inject } from '@nestjs/common';
import type { Me } from '@astro-soul/shared';
import { CurrentUser } from '../auth/current-user.decorator';
import type { VerifiedInitData } from '../auth/init-data';
import { MeService } from './me.service';

@Controller('me')
export class MeController {
  constructor(@Inject(MeService) private readonly meService: MeService) {}

  @Get()
  async getMe(@CurrentUser() auth: VerifiedInitData): Promise<Me> {
    return this.meService.getMe(auth);
  }
}
