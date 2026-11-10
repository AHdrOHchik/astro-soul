import type { components } from '../api/schema.gen';

/** A product event as `POST /events` takes it. */
export type ClientEvent = components['schemas']['ClientEvent'];
export type EventName = ClientEvent['name'];

/**
 * Every event of the contract. Typed against `ClientEvent.name`: an event added to
 * or removed from the contract breaks the build here. An unknown name is not a
 * small thing: the server refuses the whole batch it arrives in.
 */
export const EVENT_NAMES: Record<EventName, true> = {
  app_open: true,
  consent_view: true,
  consent_accepted: true,
  birth_date_done: true,
  birth_time_done: true,
  birth_place_done: true,
  step_back: true,
  place_search: true,
  place_search_empty: true,
  place_search_failed: true,
  chart_requested: true,
  chart_created: true,
  chart_failed: true,
  chart_restored: true,
  validation_failed: true,
  paywall_view: true,
  checkout_opened: true,
  payment_succeeded: true,
  payment_cancelled: true,
  share_clicked: true,
  screen_view: true,
};

/** The screens, under the names the events call them. */
export type AnalyticsStep =
  | 'welcome'
  | 'consent'
  | 'privacy'
  | 'terms'
  | 'birth_date'
  | 'birth_time'
  | 'birth_place'
  | 'chart';

/** Request fields the server may reject, as `details.field_errors` names them. */
const REJECTED_FIELDS = [
  'birth_date',
  'birth_time',
  'time_precision',
  'birth_place',
  'consent',
  'consent.version',
  'query',
  'body',
] as const;

export type RejectedField = (typeof REJECTED_FIELDS)[number] | 'other';

/** The field name is the server's string; an event carries it only when it is one of the known ones. */
export function rejectedFieldOf(field: string): RejectedField {
  return (REJECTED_FIELDS as readonly string[]).includes(field) ? (field as RejectedField) : 'other';
}

/**
 * What an event says besides its name. Every value comes from a closed list in the
 * code: a screen, an error code, the name of a request field, the version of the
 * legal texts. Nothing the user typed, chose or was shown is ever a value here:
 * events must not carry personal data (the contract, AGENTS.md §8).
 */
export interface EventProps {
  consent_accepted: { version: string };
  step_back: { step: AnalyticsStep };
  screen_view: { step: AnalyticsStep };
  place_search_failed: { code: string };
  chart_failed: { code: string };
  validation_failed: { step: AnalyticsStep; code: 'VALIDATION_FAILED'; field?: RejectedField };
}

/** Reports one event. Events outside `EventProps` take no props at all. */
export type Track = <Name extends EventName>(
  name: Name,
  ...props: Name extends keyof EventProps ? [props: EventProps[Name]] : []
) => void;

/**
 * The only keys an event of this app may carry. The check is repeated at run time, when an
 * event is queued: the types above do not stop a value that was cast on its way here.
 */
export const PROP_KEYS = ['step', 'code', 'field', 'version'] as const;

/** The contract's limit for a string value; a longer one makes the server refuse the whole batch. */
export const MAX_PROP_LENGTH = 64;

function isPropValue(value: unknown): value is string | number | boolean {
  if (typeof value === 'string') return value.length <= MAX_PROP_LENGTH;
  if (typeof value === 'number') return Number.isFinite(value);
  return typeof value === 'boolean';
}

/** Keeps the known keys with values the contract allows; undefined when nothing is left. */
export function cleanProps(props: object | undefined): ClientEvent['props'] {
  if (props === undefined) return undefined;
  const source = props as Readonly<Record<string, unknown>>;
  const clean: NonNullable<ClientEvent['props']> = {};
  for (const key of PROP_KEYS) {
    const value = source[key];
    if (isPropValue(value)) clean[key] = value;
  }
  return Object.keys(clean).length > 0 ? clean : undefined;
}
