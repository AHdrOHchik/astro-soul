import { useEffect } from 'react';
import { setClosingConfirmation } from '../telegram';

/** Protect the in-memory draft only while its form is on screen. */
export function useClosingConfirmation(dirty: boolean): void {
  useEffect(() => {
    if (!dirty) return undefined;
    setClosingConfirmation(true);
    return () => { setClosingConfirmation(false); };
  }, [dirty]);
}
