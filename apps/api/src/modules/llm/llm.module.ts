import { Global, Module } from '@nestjs/common';
import { CommonModule } from '../../common/common.module';
import { JsonLogger } from '../../common/logger';
import { APP_ENV } from '../../config/env.module';
import type { AppEnv } from '../../config/env';
import { FakeLlmProvider } from './fake-llm';
import { GigaChatClient, type LlmProvider } from './llm.client';

/** Токен провайдера: в тестах подменяется одной строкой `overrideProvider`. */
export const LLM_PROVIDER = Symbol('LLM_PROVIDER');

/**
 * Выбор провайдера — по окружению, а не по вкусу.
 *
 * Нет `GIGACHAT_AUTH_KEY`/`GIGACHAT_SCOPE` (или явный `LLM_FAKE=1`) — работает
 * подставной провайдер, и это **видно**: предупреждение в лог при старте и
 * `model = fake-llm` в каждом разборе. Тихой подмены модели нет.
 */
@Global()
@Module({
  imports: [CommonModule],
  providers: [
    {
      provide: LLM_PROVIDER,
      inject: [APP_ENV, JsonLogger],
      useFactory: (env: AppEnv, logger: JsonLogger): LlmProvider => {
        const forcedFake = env.LLM_FAKE === '1';

        if (forcedFake || !GigaChatClient.isConfigured(env)) {
          logger.warn('llm_fake_provider', {
            reason: forcedFake ? 'LLM_FAKE=1' : 'нет GIGACHAT_AUTH_KEY и/или GIGACHAT_SCOPE',
            model: 'fake-llm',
            // Провайдер не тратит деньги: счётчик расходов остаётся нулевым.
            price_per_1k_rub: 0,
          });
          return new FakeLlmProvider();
        }

        logger.info('llm_provider', { provider: 'gigachat', model: env.LLM_MODEL });
        return new GigaChatClient(env, logger);
      },
    },
  ],
  exports: [LLM_PROVIDER],
})
export class LlmModule {}
