import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import { unauthorized } from '../../common/api-error';
import type { AuthenticatedRequest } from './init-data.middleware';
import type { VerifiedInitData } from './init-data';

/**
 * Достаёт проверенный initData. Если middleware не отработал —
 * это ошибка конфигурации, а не 200 с пустым пользователем.
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): VerifiedInitData => {
    const request = context.switchToHttp().getRequest<Partial<AuthenticatedRequest>>();
    if (request.initData === undefined) {
      throw unauthorized({ reason: 'missing_verified_init_data' });
    }
    return request.initData;
  },
);
