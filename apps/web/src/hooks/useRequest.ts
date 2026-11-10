import { useCallback, useEffect, useState } from 'react';
import { isAbortError, isApiError } from '../api';

type Settled<T> = { status: 'ready'; data: T } | { status: 'error'; error: unknown };
export type RequestState<T> = { status: 'loading' } | Settled<T>;

/**
 * Runs `load` when the component mounts, again on `retry()` and whenever `load`
 * changes identity (so wrap it in useCallback). The request is cancelled on
 * unmount; an answer that arrives for an outdated request is never shown.
 */
export function useRequest<T>(load: (signal: AbortSignal) => Promise<T>): RequestState<T> & { retry: () => void } {
  const [attempt, setAttempt] = useState(0);
  const [settled, setSettled] = useState<{ load: typeof load; attempt: number; result: Settled<T> } | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal).then(
      (data) => {
        setSettled({ load, attempt, result: { status: 'ready', data } });
      },
      (error: unknown) => {
        if (isAbortError(error)) return;
        // Anything that is not an API failure is a bug in the app: keep it visible to developers.
        if (!isApiError(error)) console.error(error);
        setSettled({ load, attempt, result: { status: 'error', error } });
      },
    );
    return () => {
      controller.abort();
    };
  }, [load, attempt]);

  const retry = useCallback(() => {
    setAttempt((current) => current + 1);
  }, []);

  const isCurrent = settled !== null && settled.load === load && settled.attempt === attempt;
  return isCurrent ? { ...settled.result, retry } : { status: 'loading', retry };
}
