import { AlertIcon, Button, StateView } from '@astro-soul/ui';
import type { ReactNode } from 'react';
import { isApiError, type ApiErrorCode } from '../api';
import { ru } from '../i18n/ru';
import type { Telegram } from '../telegram';

/** Failures where the same request may succeed a moment later. */
const RETRYABLE: readonly ApiErrorCode[] = ['NETWORK', 'TIMEOUT', 'INTERNAL', 'UPSTREAM_LLM', 'RATE_LIMITED', 'INVALID_RESPONSE'];

export interface ErrorStateProps {
  error: unknown;
  telegram: Pick<Telegram, 'isTelegram' | 'close'>;
  /** Offered only for failures worth repeating. */
  onRetry?: () => void;
  /** Extra actions, e.g. a way back to fix the input. */
  children?: ReactNode;
}

/**
 * The error state of a screen. Prefers the server's own message (written for
 * the user, in Russian) and shows the request id so support can find the call.
 */
export function ErrorState({ error, telegram, onRetry, children }: ErrorStateProps) {
  const apiError = isApiError(error) ? error : null;
  const code = apiError?.code ?? 'INTERNAL';
  const unauthorized = code === 'UNAUTHORIZED';
  // Without Telegram there is no initData to sign in with: explain that instead of "session expired".
  const outside = unauthorized && !telegram.isTelegram;
  const copy = outside ? ru.outsideTelegram : ru.errors[code];
  const text = outside ? copy.text : (apiError?.serverMessage ?? copy.text);
  const canRetry = onRetry !== undefined && RETRYABLE.includes(code);
  const canClose = unauthorized && telegram.isTelegram;

  return (
    <StateView
      role="alert"
      icon={<AlertIcon />}
      title={copy.title}
      text={text}
      caption={apiError?.requestId ? ru.common.requestId(apiError.requestId) : undefined}
    >
      {canRetry && <Button onClick={onRetry}>{ru.common.retry}</Button>}
      {canClose && (
        <Button
          onClick={() => {
            telegram.close();
          }}
        >
          {ru.common.close}
        </Button>
      )}
      {children}
    </StateView>
  );
}
