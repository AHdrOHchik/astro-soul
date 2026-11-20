import { Controller, Headers, HttpCode, Inject, Post } from '@nestjs/common';
import type { SubscriptionCancelResult } from '@astro-soul/shared';
import { ApiError, conflict, invalidFields, internalError } from '../../common/api-error';
import { CurrentUser } from '../auth/current-user.decorator';
import type { VerifiedInitData } from '../auth/init-data';
import { IDEMPOTENCY_KEY, IDEMPOTENCY_KEY_MAX } from '../reports/reports.dto';
import { BillingService } from './billing.service';
import type { CancelAutoRenewResult } from './subscription-cancel.service';

/** Текст для экрана, когда клиент забыл ключ идемпотентности. */
const KEY_MESSAGE = 'Повтори отмену — приложение не передало ключ идемпотентности';

/**
 * Ключ идемпотентности отмены: те же правила, что у `POST /reports`
 * (`IDEMPOTENCY_KEY_MAX`, `IDEMPOTENCY_KEY`), но свой текст ошибки.
 *
 * Отдельная функция, а не общий `parseIdempotencyKey` из разборов: сообщение
 * «Повтори заказ» на экране отмены читается как сбой оплаты. Сама проверка —
 * одна и та же, дублировать правила (64 символа, набор знаков) нельзя: они
 * разъедутся.
 */
export function parseCancelKey(value: string | undefined): string {
  const key = value?.trim() ?? '';

  if (key === '') {
    throw invalidFields([{ field: 'Idempotency-Key', message: KEY_MESSAGE }]);
  }

  if (key.length > IDEMPOTENCY_KEY_MAX || !IDEMPOTENCY_KEY.test(key)) {
    throw invalidFields([
      {
        field: 'Idempotency-Key',
        message: 'Ключ идемпотентности — до 64 символов: буквы, цифры, «-», «_», «.», «:»',
      },
    ]);
  }

  return key;
}

/**
 * `POST /subscription/cancel` (контракт 1.6.5).
 *
 * Отдельный контроллер, а не метод в `BillingController`: у отмены свой набор
 * ответов (`409` двух видов, `502` с причиной) и своя кнопка на экране.
 * Путь `subscription/cancel`, а не `billing/subscription/cancel` — этот
 * маршрут про состояние человека, а не про витрину и счета.
 *
 * Почему маршрут вообще появился: кнопка «открыть подписки в Telegram» вела на
 * `tg://settings/star_subscriptions`, такого адреса в Telegram нет. Отменить
 * автопродление из приложения было нельзя — только удалить аккаунт.
 *
 * `DELETE /me` этот контроллер не трогает: там удаление данных идёт в любом
 * случае, а здесь требуется активная подписка и подтверждение Bot API.
 */
@Controller('subscription')
export class SubscriptionController {
  constructor(@Inject(BillingService) private readonly billing: BillingService) {}

  @Post('cancel')
  @HttpCode(200)
  async cancel(
    @CurrentUser() auth: VerifiedInitData,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ): Promise<SubscriptionCancelResult> {
    // Ключ проверяем первым: без него запрос не должен доходить до Bot API.
    parseCancelKey(idempotencyKey);

    const result: CancelAutoRenewResult = await this.billing.cancelSubscription(auth);

    switch (result.kind) {
      case 'cancelled':
        return {
          status: 'cancelled',
          auto_renew: false,
          current_period_end: result.currentPeriodEnd,
        };
      case 'no_active_subscription':
        throw conflict({
          reason: 'no_active_subscription',
          details: { reason: 'no_active_subscription' },
          message: 'Активной подписки нет — отменять нечего.',
        });
      case 'already_cancelled':
        throw conflict({
          reason: 'already_cancelled',
          details: { reason: 'already_cancelled' },
          message: 'Автопродление уже отключено. Доступ остаётся до конца оплаченного периода.',
        });
      case 'upstream':
        throw upstreamReason(result.code);
    }

    // Сюда попасть нельзя: все четыре вида разобраны выше (`result` тут —
    // `never`). Строка нужна, чтобы новый вид результата не превратился в
    // молчаливый `undefined`.
    throw internalError({ reason: 'cancel_unhandled' });
  }
}

/**
 * `502` с причиной. Код `INTERNAL`, а не отдельный `UPSTREAM`: в контракте
 * такого кода нет, и `POST /billing/invoice` на сбой Bot API отвечает так же.
 * Клиент показывает текст по `details.reason`, а не по `code`.
 */
function upstreamReason(code: 'telegram_error' | 'timeout' | 'no_charge_id'): ApiError {
  const base = {
    reason: code,
    details: { reason: code },
    logFields: { reason: code },
  } as const;

  if (code === 'no_charge_id') {
    return new ApiError('INTERNAL', 502, {
      ...base,
      message:
        'Не получилось отключить автопродление: не нашли платёж подписки. Напиши в поддержку — отключим вручную.',
    });
  }

  return new ApiError('INTERNAL', 502, {
    ...base,
    message:
      code === 'timeout'
        ? 'Telegram не ответил. Попробуем ещё раз автоматически — автопродление пока включено.'
        : 'Telegram не подтвердил отмену. Попробуем ещё раз автоматически — автопродление пока включено.',
  });
}
