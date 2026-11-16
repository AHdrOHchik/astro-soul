import { Body, Controller, Get, Header, HttpCode, Inject, Post } from '@nestjs/common';
import type { Invoice, SubscriptionState } from '@astro-soul/shared';
import { CurrentUser } from '../auth/current-user.decorator';
import type { VerifiedInitData } from '../auth/init-data';
import { BillingService } from './billing.service';
import type { PlanOffer } from './plan-offers';

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

  /**
   * Витрина — 1.5.9. `no-store` не косметика: ответ зависит от
   * `PAYMENTS_TEST_PLANS`, и закэшированный список пережил бы и включение
   * флага (тестовых не видно), и выключение (тестовые видны всем).
   */
  @Get('plans')
  @Header('Cache-Control', 'no-store')
  listPlans(): { plans: readonly PlanOffer[] } {
    return { plans: this.billing.listPlans() };
  }

  @Get('subscription')
  async subscription(@CurrentUser() auth: VerifiedInitData): Promise<SubscriptionState> {
    return this.billing.getSubscription(auth);
  }
}
