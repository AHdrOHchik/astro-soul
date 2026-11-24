import { Body, Controller, Get, HttpCode, Inject, Post, Query } from '@nestjs/common';
import type { Me } from '@astro-soul/shared';
import { ApiError, invalidFields, rateLimited } from '../../common/api-error';
import { JsonLogger } from '../../common/logger';
import { CurrentUser } from '../auth/current-user.decorator';
import type { VerifiedInitData } from '../auth/init-data';
import { EntitlementsService } from '../entitlements/entitlements.service';
import { toEntitlementsDto } from '../entitlements/entitlements.dto';
import { UsersRepository } from '../users/users.repository';
import { AccessCodesService } from './access-codes.service';
import { CodeActivationThrottle } from './code-activation-throttle.service';
import { FoundersService } from './founders.service';
import { ReferralsService } from './referrals.service';

/** Форма ответа `POST /me/activate-code` и `POST /me/founder-claim` (1.6.14). */
export interface EntitlementsResponse {
  readonly entitlements: NonNullable<Me['entitlements']>;
}

/** `GET /founders/count` — публичный счётчик акции. */
export interface FoundersCountResponse {
  readonly taken: number;
  readonly total: number;
}

function readCode(body: unknown): string {
  if (typeof body !== 'object' || body === null) {
    throw invalidFields([{ field: 'code', message: 'Введи код' }]);
  }

  const value = (body as { code?: unknown }).code;

  if (typeof value !== 'string' || value.trim() === '') {
    throw invalidFields([{ field: 'code', message: 'Введи код' }]);
  }

  return value;
}

/**
 * Активация права по коду и заявка основателя (итерация 39).
 *
 * Безопасность: оба маршрута требуют initData (middleware), поэтому «активируй
 * чужой код на себя» невозможно — пользователь всегда берётся из подписи, а не
 * из тела. Код в теле — единственный параметр.
 */
@Controller('me')
export class MeGrantsController {
  constructor(
    @Inject(AccessCodesService) private readonly codes: AccessCodesService,
    @Inject(FoundersService) private readonly founders: FoundersService,
    @Inject(ReferralsService) private readonly referrals: ReferralsService,
    @Inject(EntitlementsService) private readonly entitlements: EntitlementsService,
    @Inject(UsersRepository) private readonly users: UsersRepository,
    @Inject(CodeActivationThrottle) private readonly throttle: CodeActivationThrottle,
    @Inject(JsonLogger) private readonly logger: JsonLogger,
  ) {}

  /**
   * `POST /me/activate-code` → `200 {entitlements}`.
   *
   * Ошибки контракта 1.6.14: `404 code_not_found`, `409 code_exhausted`,
   * `409 already_activated`, `410 code_expired`, `422` (формат), `401` (нет
   * initData). Ответ — полный блок прав, чтобы клиенту не нужен был второй
   * запрос и он не показывал «активировано» без подтверждения сервера.
   *
   * Лимит (1.6.17): 10 **неудачных** попыток в час на человека →
   * `429 code_activation_throttled` с `retry_after_seconds`. Успешная активация
   * снимает счётчик, поэтому «ошибся дважды, вспомнил код, ввёл» проходит с
   * третьей попытки — это и проверяет тест.
   */
  @Post('activate-code')
  @HttpCode(200)
  async activateCode(
    @CurrentUser() auth: VerifiedInitData,
    @Body() body: unknown,
  ): Promise<EntitlementsResponse> {
    const { userId } = await this.users.ensureUser({
      telegramUserId: auth.telegramUserId,
      languageCode: auth.user.language_code,
    });

    // Проверка стоит до похода в базу: заблокированный перебор не должен стоить
    // нам ни запроса, ни поиска кода.
    const retryAfter = this.throttle.retryAfterSeconds(userId);

    if (retryAfter !== null) {
      this.logger.warn('code_activation_throttled', {
        user_id: userId,
        retry_after_seconds: retryAfter,
        note: 'больше лимита неудачных активаций за час',
      });

      throw rateLimited({
        reason: 'code_activation_throttled',
        message: `Слишком много попыток. Попробуй снова через ${Math.ceil(retryAfter / 60)} мин`,
        details: {
          reason: 'code_activation_throttled',
          retry_after_seconds: retryAfter,
          window_seconds: 3600,
        },
      });
    }

    const code = readCode(body);

    try {
      await this.codes.activate(userId, code);
    } catch (error) {
      // Считаем именно неудачи активации (нет кода, исчерпан, просрочен, уже
      // активирован), а не «кривое тело»: 422 на пустую строку — это опечатка
      // ввода, и она не должна съедать час попыток. Поэтому формат (и любой
      // другой `VALIDATION_FAILED`) из счётчика исключён — иначе двенадцать
      // опечаток подряд закрыли бы человеку активацию на час.
      if (error instanceof ApiError && error.code !== 'VALIDATION_FAILED') {
        this.throttle.registerFailure(userId);
      }
      throw error;
    }

    this.throttle.registerSuccess(userId);

    return { entitlements: await this.entitlementsDto(userId) };
  }

  /**
   * `POST /me/founder-claim` → `200 {entitlements}`.
   *
   * `409 founders_exhausted` — мест больше нет; `200` с тем же местом — человек
   * уже основатель (идемпотентность важна: приложение может перезапуститься
   * посреди заявки).
   */
  @Post('founder-claim')
  @HttpCode(200)
  async claimFounder(@CurrentUser() auth: VerifiedInitData): Promise<EntitlementsResponse & {
    readonly founder_place: number;
  }> {
    const { userId } = await this.users.ensureUser({
      telegramUserId: auth.telegramUserId,
      languageCode: auth.user.language_code,
    });

    const claim = await this.founders.claim(userId);

    return { founder_place: claim.place, entitlements: await this.entitlementsDto(userId) };
  }

  /**
   * `GET /me/referral` — ссылка приглашения и счётчик приглашённых.
   *
   * Отдельный маршрут, а не только поле в `/me`: ссылку нужно показать на
   * экране «пригласи друга», где `/me` уже загружен, а `referral_link` в нём
   * может отсутствовать (старый сервер). `short_id` не ПДн — за ним нет ни
   * `telegram_id`, ни `user_id`.
   */
  @Get('referral')
  async referral(
    @CurrentUser() auth: VerifiedInitData,
  ): Promise<{ link: string | null; short_id: string; joined: number; rewarded: number }> {
    const { userId } = await this.users.ensureUser({
      telegramUserId: auth.telegramUserId,
      languageCode: auth.user.language_code,
    });

    const shortId = await this.referrals.ensureShortId(userId);
    const stats = await this.referrals.statsFor(userId);

    return {
      short_id: shortId,
      link: this.referrals.linkFor(shortId),
      joined: stats.joined,
      rewarded: stats.rewarded,
    };
  }

  private async entitlementsDto(userId: string): Promise<NonNullable<Me['entitlements']>> {
    const [rights, grants] = await Promise.all([
      this.entitlements.getEntitlements(userId),
      this.entitlements.getGrantEntitlements(userId),
    ]);

    return toEntitlementsDto(rights, grants);
  }
}

/**
 * `GET /founders/count` — публичный счётчик «первые 50».
 *
 * Публичный осознанно (в контракте `security: []`): число мест нужно витрине до
 * входа, а ПДн в нём нет — только два числа. Маршрут добавлен в белый список
 * `public-routes.ts`, и это единственный новый публичный путь итерации.
 */
@Controller('founders')
export class FoundersController {
  constructor(@Inject(FoundersService) private readonly founders: FoundersService) {}

  @Get('count')
  async count(@Query('t') _cacheBust?: string): Promise<FoundersCountResponse> {
    return this.founders.count();
  }
}
