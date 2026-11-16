import { useEffect, useState } from 'react';
import { errorCodeOf, trackRejection, type Track } from '../analytics';
import { isAbortError, type Api, type GeoPlace } from '../api';

/** Pause after the last keystroke before asking the server. */
export const SEARCH_DEBOUNCE_MS = 400;

type Lookup = { places: GeoPlace[] } | { error: unknown };

export type PlaceSearch =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'empty' }
  | { status: 'ready'; places: GeoPlace[] }
  | { status: 'error'; error: unknown; retry: () => void };

/**
 * Type-ahead over `POST /geo/resolve`: debounced, the previous request is
 * cancelled, answers are remembered per query for as long as the screen is
 * open (the endpoint is rate limited, so typing a name, deleting a letter and
 * typing it back should not cost three calls).
 *
 * The search starts from the length the server allows (`query` of `POST /geo/resolve`:
 * a shorter one is a 422). That length is not a number of this build: the server
 * owns it and reports it in `GET /me` (`limits.geo_min_query_length`), and it is
 * counted the same way here: after trimming. No `limits` in the answer (an older
 * server) — nothing is blocked, and the server's own 422 with `field_errors[0].field
 * = query` is what the user sees.
 *
 * Events report that a search ran and how it ended, never what was searched for.
 */
export function usePlaceSearch(
  api: Pick<Api, 'resolveGeo'>,
  query: string,
  track: Track,
  /** Shortest query the server takes; `undefined` — the server did not say. */
  minQueryLength?: number,
): PlaceSearch {
  const term = query.trim();
  // A Map, not an object: the keys are user input ("constructor" is a valid thing to type).
  const [lookups, setLookups] = useState<ReadonlyMap<string, Lookup>>(() => new Map());
  // Without the server's number every keystroke may be sent: blocking on a guess
  // would be worse — the field would refuse a query the server would have taken.
  const active = minQueryLength === undefined ? term.length > 0 : term.length >= minQueryLength;
  const lookup = active ? lookups.get(term) : undefined;
  const pending = active && lookup === undefined;

  useEffect(() => {
    if (!pending) return undefined;
    const controller = new AbortController();
    const remember = (result: Lookup) => {
      setLookups((previous) => new Map(previous).set(term, result));
    };
    const timer = setTimeout(() => {
      track('place_search');
      api.resolveGeo(term, controller.signal).then(
        (places) => {
          if (places.length === 0) track('place_search_empty');
          remember({ places });
        },
        (error: unknown) => {
          if (isAbortError(error)) return;
          track('place_search_failed', { code: errorCodeOf(error) });
          trackRejection(track, 'birth_place', error);
          remember({ error });
        },
      );
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [api, term, pending, track]);

  const retry = () => {
    setLookups((previous) => {
      const next = new Map(previous);
      next.delete(term);
      return next;
    });
  };

  if (!active) return { status: 'idle' };
  if (lookup === undefined) return { status: 'loading' };
  if ('error' in lookup) return { status: 'error', error: lookup.error, retry };
  return lookup.places.length === 0 ? { status: 'empty' } : { status: 'ready', places: lookup.places };
}
