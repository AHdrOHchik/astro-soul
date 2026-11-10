import { MIN_QUERY_LENGTH } from '@astro-soul/shared';
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
 * The search starts from the length the contract allows (`query` of `POST /geo/resolve`:
 * a shorter one is a 422). The number is the one the server checks against, from
 * `@astro-soul/shared`, and it is counted the same way: after trimming.
 *
 * Events report that a search ran and how it ended, never what was searched for.
 */
export function usePlaceSearch(api: Pick<Api, 'resolveGeo'>, query: string, track: Track): PlaceSearch {
  const term = query.trim();
  // A Map, not an object: the keys are user input ("constructor" is a valid thing to type).
  const [lookups, setLookups] = useState<ReadonlyMap<string, Lookup>>(() => new Map());
  const active = term.length >= MIN_QUERY_LENGTH;
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
