import { useEffect, useRef } from 'react';
import type { AnalyticsStep, ClientCheckedField, Track } from '../analytics';

/**
 * Reports a check of the app's own that stopped the user (`validation_failed_client`):
 * once for every error message that appears at `field`. `issue` names what the message
 * says and is null while there is none; it only tells one message from the next and is
 * never sent.
 */
export function useClientCheck(track: Track, step: AnalyticsStep, field: ClientCheckedField, issue: string | null): void {
  // Starts from what the screen opens with: a message that is already there was reported when it
  // appeared. A ref, not the effect alone: a development build runs every effect twice.
  const reported = useRef(issue);
  useEffect(() => {
    if (reported.current === issue) return;
    reported.current = issue;
    if (issue !== null) track('validation_failed_client', { step, field });
  }, [track, step, field, issue]);
}
