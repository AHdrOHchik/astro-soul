import { Body, Controller, Get, HttpCode, Inject, Post } from '@nestjs/common';
import type { Invoice, SubscriptionState } from '@astro-soul/shared';
import { CurrentUser } from '../auth/current-user.decorator';
import type { VerifiedInitData } from '../auth/init-data';
import { BillingService } from './billing.service';

@Controller('billing')
export class BillingController {
  constructor(@Inject(BillingService) private readonly billing: BillingService) {}

  @Post('invoice')
  @HttpCode(201)
  async createInvoice(
    @CurrentUser() auth: VerifiedInitData,
    @Body() body: unknown,
  ): Promise<Invoice> {
    return this.billing.createInvoice(auth, body);
  }

  @Get('subscription')
  async subscription(@CurrentUser() auth: VerifiedInitData): Promise<SubscriptionState> {
    return this.billing.getSubscription(auth);
  }
}
