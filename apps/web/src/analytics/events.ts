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
  onboarding_start: true,
  onboarding_birth_date_set: true,
  onboarding_time_set: true,
  onboarding_place_set: true,
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
  validation_failed_client: true,
  mini_reading_view: true,
  wheel_shared: true,
  paywall_view: true,
  checkout_started: true,
  checkout_opened: true,
  payment_succeeded: true,
  payment_cancelled: true,
  report_requested: true,
  report_ready_view: true,
  forecast_view: true,
  ask_used: true,
  quota_exhausted: true,
  subscription_expired_seen: true,
  data_deleted: true,
  error_shown: true,
  share_clicked: true,
  screen_view: true,
};

/**
 * Events the contract lists and the app still keeps to itself. The screens report them,
 * the queue lets none through.
 *
 * `validation_failed_client`: the contract has the name since 1.5.1, the server in `main`
 * does not take it yet, and one name a server does not know costs the whole batch (422).
 * It goes out once the backend confirms the name is accepted: by deleting the line here.
 */
const HELD_BACK: readonly EventName[] = ['validation_failed_client'];

/** Whether the event may go to the server: the contract lists it, and nothing holds it back. */
export function isSendable(name: string): name is EventName {
  return Object.prototype.hasOwnProperty.call(EVENT_NAMES, name) && !(HELD_BACK as readonly string[]).includes(name);
}

/** The screens, under the names the events call them. */
export type AnalyticsStep =
  | 'welcome'
  | 'consent'
  | 'privacy'
  | 'terms'
  | 'birth_date'
  | 'birth_time'
  | 'birth_place'
  | 'chart'
  | 'paywall'
  | 'report'
  | 'settings';

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

/** The request fields the app checks itself before anything is sent, under the same names. */
export type ClientCheckedField = Extract<RejectedField, 'birth_date' | 'birth_time' | 'time_precision' | 'birth_place'>;

/** The field name is the server's string; an event carries it only when it is one of the known ones. */
export function rejectedFieldOf(field: string): RejectedField {
  return (REJECTED_FIELDS as readonly string[]).includes(field) ? (field as RejectedField) : 'other';
}

/** What was being bought: a code of the contract's `PlanCode`. */
type PlanCode = components['schemas']['PlanCode'];

/**
 * What an event says besides its name. Every value comes from a closed list in the
 * code (a screen, an error code, the name of a request field, the version of the
 * legal texts, a plan) or is an id the server gave out (a report). Nothing the user
 * typed, chose or was shown is ever a value here: events must not carry personal
 * data (the contract, AGENTS.md §8).
 */
export interface EventProps {
  consent_accepted: { version: string };
  step_back: { step: AnalyticsStep };
  screen_view: { step: AnalyticsStep };
  place_search_failed: { code: string };
  chart_failed: { code: string };
  validation_failed: { step: AnalyticsStep; code: 'VALIDATION_FAILED'; field?: RejectedField };
  /** A check of the app's own stopped the user. Which field, never why: the reason would be a fact about the value. */
  validation_failed_client: { step: AnalyticsStep; field: ClientCheckedField };
  /** The user tapped «pay»: before the server is asked for an invoice. */
  checkout_started: { plan_code: PlanCode };
  /** The invoice exists and Telegram is showing it. */
  checkout_opened: { plan_code: PlanCode };
  /** The server confirmed the purchase. Telegram's own «paid» is not this event. */
  payment_succeeded: { plan_code: PlanCode };
  payment_cancelled: { plan_code: PlanCode };
  /** A finished report is on screen. */
  report_ready_view: { report_id: string };
  /** The server would not give something out for free any more; the paywall follows. */
  quota_exhausted: { step: AnalyticsStep };
  /**
   * A failure was shown. `code` is the HTTP status when the server answered, the client's
   * own code when it did not, or the name of a failure that is not a request at all.
   */
  error_shown: { screen: AnalyticsStep; code: string };
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
export const PROP_KEYS = ['step', 'code', 'field', 'version', 'screen', 'plan_code', 'report_id'] as const;

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
