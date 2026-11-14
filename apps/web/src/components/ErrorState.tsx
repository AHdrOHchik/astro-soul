import { AlertIcon, Button, StateView } from '@astro-soul/ui';
import type { ReactNode } from 'react';
import { isApiError, serverTextOf, type ApiErrorCode } from '../api';
import { ru } from '../i18n/ru';
import type { Telegram } from '../telegram';
import { Reference } from './Reference';

/** Failures where the same request may succeed a moment later. `GEO_NOT_FOUND` is one: the geodata provider is down. */
const RETRYABLE: readonly ApiErrorCode[] = [
  'NETWORK',
  'TIMEOUT',
  'INTERNAL',
  'UPSTREAM_LLM',
  'GEO_NOT_FOUND',
  'RATE_LIMITED',
  'INVALID_RESPONSE',
];

export interface ErrorStateProps {
  error: unknown;
  telegram: Pick<Telegram, 'isTelegram' | 'close'>;
  /** Offered only for failures worth repeating. */
  onRetry?: () => void;
  /** In place of the title the error code has: for a screen that knows what exactly failed. */
  title?: string;
  /** In place of the text of the server and of the code: for a failure the screen has its own words for. */
  text?: string;
  /** Extra actions, e.g. a way back to fix the input. */
  children?: ReactNode;
}

/**
 * The error state of a screen. Prefers the server's own message when it is the
 * Russian text the contract promises, and shows the request id so support can
 * find the call: in small print, copied by a tap.
 */
export function ErrorState({ error, telegram, onRetry, title, text, children }: ErrorStateProps) {
  const apiError = isApiError(error) ? error : null;
  const code = apiError?.code ?? 'INTERNAL';
  const unauthorized = code === 'UNAUTHORIZED';
  // Without Telegram there is no initData to sign in with: explain that instead of "session expired".
  const outside = unauthorized && !telegram.isTelegram;
  const copy = outside ? ru.outsideTelegram : ru.errors[code];
  const shownText = outside ? copy.text : (text ?? serverTextOf(error) ?? copy.text);
  const canRetry = onRetry !== undefined && RETRYABLE.includes(code);
  const canClose = unauthorized && telegram.isTelegram;
  const requestId = apiError?.requestId;

  return (
    <StateView
      role="alert"
      icon={<AlertIcon />}
      title={outside ? copy.title : (title ?? copy.title)}
      text={shownText}
      caption={requestId ? <Reference value={requestId} label={ru.common.requestId(requestId)} /> : undefined}
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
