import { z } from 'zod';
import type { FieldError } from '@astro-soul/shared';
import { invalidFields } from '../../common/api-error';

/**
 * События продукта, которые Mini App присылает батчем (контракт 1.3.0).
 *
 * Список закрытый: `x-analytics-events` в `api.openapi.yaml` и этот массив
 * обязаны совпадать. Новое событие = правка контракта, а не «прилетело само».
 */
export const ANALYTICS_EVENTS = [
  'app_open',
  'consent_view',
  'consent_accepted',
  'birth_date_done',
  'birth_time_done',
  'birth_place_done',
  'step_back',
  'place_search',
  'place_search_empty',
  'place_search_failed',
  'chart_requested',
  'chart_created',
  'chart_failed',
  'chart_restored',
  'validation_failed',
  'paywall_view',
  'checkout_opened',
  'payment_succeeded',
  'payment_cancelled',
  'share_clicked',
  'screen_view',
] as const;

export type AnalyticsEvent = (typeof ANALYTICS_EVENTS)[number];

/** Контракт: батч до 20 событий. Больше — ошибка клиента, а не наша очередь. */
export const MAX_EVENTS_PER_BATCH = 20;

/** Клиентское время не может уехать в будущее дальше, чем на 5 минут. */
const CLOCK_SKEW_MS = 5 * 60_000;
/** И не может быть старше суток: такой батч уже бесполезен для воронки. */
const MAX_EVENT_AGE_MS = 24 * 60 * 60_000;

/**
 * Ключи, которых в `props` быть не может: в `events` нет ПДн.
 * Проверяем явно, чтобы «случайно» прилетевший профиль рождения не осел в БД.
 */
const BANNED_PROP_KEYS = [
  'birth_date',
  'birth_time',
  'birth_place',
  'date',
  'time',
  'place',
  'city',
  'query',
  'lat',
  'lon',
  'tz',
  'first_name',
  'last_name',
  'username',
  'phone',
  'email',
] as const;

const propValueSchema = z.union([z.string().max(64), z.number(), z.boolean()]);

export const clientEventSchema = z.object({
  name: z.enum(ANALYTICS_EVENTS),
  at: z.string().datetime({ offset: true }),
  props: z.record(propValueSchema).optional(),
});

export const eventsBatchSchema = z.object({
  events: z.array(clientEventSchema).min(1).max(MAX_EVENTS_PER_BATCH),
});

export type ClientEvent = z.infer<typeof clientEventSchema>;

const FIELD_MESSAGES: Readonly<Record<string, string>> = {
  events: 'События должны быть батчем от 1 до 20 штук',
  'events.name': 'Такого события нет в контракте',
  'events.at': 'Время события — ISO 8601 с часовым поясом',
  'events.props': 'Свойства события — короткие строки, числа или флаги',
};

function messageFor(field: string): string {
  return FIELD_MESSAGES[field] ?? 'Проверь тело запроса';
}

/** Машинное имя поля в `field_errors`: `events[3].name` → `events.name`. */
function fieldOf(path: readonly (string | number)[]): string {
  const [head, , key] = path;
  if (typeof head !== 'string') {
    return 'body';
  }
  return typeof key === 'string' ? `${head}.${key}` : head;
}

export interface ParsedBatch {
  readonly events: ClientEvent[];
  /** Сколько событий отброшено из-за ПДн в `props` — пишется в лог, клиенту не показывается. */
  readonly droppedForPrivacy: number;
}

/**
 * Разбор батча. Ошибки формы — 422 с `field_errors` (фронт на события не
 * реагирует и интерфейс не ломает). События с ПДн в `props` молча
 * отбрасываются: отправлять их обратно клиенту бессмысленно.
 */
export function parseEventsBatch(body: unknown, now: Date = new Date()): ParsedBatch {
  const parsed = eventsBatchSchema.safeParse(body);

  if (!parsed.success) {
    const errors: FieldError[] = [];
    const seen = new Set<string>();

    for (const issue of parsed.error.issues) {
      const field = fieldOf(issue.path);
      if (seen.has(field)) {
        continue;
      }
      seen.add(field);
      errors.push({ field, message: messageFor(field) });
    }

    throw invalidFields(errors, { reason: 'events_invalid' });
  }

  const fresh: ClientEvent[] = [];
  let droppedForPrivacy = 0;
  let droppedForTime = 0;

  for (const event of parsed.data.events) {
    const props = event.props ?? {};
    if (Object.keys(props).some((key) => (BANNED_PROP_KEYS as readonly string[]).includes(key))) {
      droppedForPrivacy += 1;
      continue;
    }

    const at = new Date(event.at).getTime();
    if (at > now.getTime() + CLOCK_SKEW_MS || at < now.getTime() - MAX_EVENT_AGE_MS) {
      droppedForTime += 1;
      continue;
    }

    fresh.push(event);
  }

  if (droppedForTime > 0 && fresh.length === 0) {
    throw invalidFields(
      [{ field: 'events.at', message: messageFor('events.at') }],
      { reason: 'events_stale' },
    );
  }

  return { events: fresh, droppedForPrivacy };
}
