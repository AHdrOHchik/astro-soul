/*
 * The forecast and the questions of the dev mock, by the rules of apps/api
 * (`modules/engagement`): a forecast is read, never made on request, and is a short
 * text without a subscription; a question is checked, then refused softly on a topic the
 * service does not take, then counted against the day's quota, then answered. Nothing is
 * calculated and no model is called: the texts below are all there is, and they say so.
 */
import type { components } from '../src/api/schema.gen';

type Schemas = components['schemas'];
export type Forecast = Schemas['Forecast'];
export type AskResponse = Schemas['AskResponse'];
type Quota = Schemas['Quota'];
type FieldError = Schemas['FieldError'];
type Focus = NonNullable<Forecast['focus']>;

/** What the forecast of this run does: as on the server, or one of the cases worth seeing. */
export type ForecastScenario = 'auto' | 'ready' | 'pending' | 'stale' | '500';

export const FORECAST_SCENARIOS: readonly ForecastScenario[] = ['auto', 'ready', 'pending', 'stale', '500'];

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The calendar day at `now` in `timeZone`, and the moment that day ends there: where the
 * server counts the days of a forecast and of the daily quotas. A mock's arithmetic: it
 * does not know about a day that is not 24 hours long.
 */
export function localDay(timeZone: string, now: number): { date: string; endsAt: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(now));
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? '00';
  const sinceMidnight = ((Number(part('hour')) * 60 + Number(part('minute'))) * 60 + Number(part('second'))) * 1000 + (now % 1000);
  return { date: `${part('year')}-${part('month')}-${part('day')}`, endsAt: now - sinceMidnight + DAY_MS };
}

/** The day before an ISO date. */
function dayBefore(date: string): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) - DAY_MS).toISOString().slice(0, 10);
}

const FOCUSES: readonly Focus[] = ['career', 'love', 'money', 'health', 'self'];

const SHORT_TEXT = 'Это текст мока, а не прогноз по твоей карте. Сегодня спокойный темп идёт на пользу: одно дело лучше довести до конца, чем начать три.';

const FULL_TEXT = [
  'Это текст мока, а не прогноз по твоей карте: настоящий пишет сервер ночью.',
  'Сегодня спокойный темп идёт на пользу: одно дело лучше довести до конца, чем начать три.',
  'В разговорах стоит переспрашивать — так меньше недоразумений.',
  'К вечеру внимание рассеивается, и важные решения лучше отложить на утро.',
].join(' ');

/**
 * The forecast of the day `date`. Without a subscription: the short text and no focus, as
 * apps/api sends it. `stale` dates it a day back: the server never does, but a forecast
 * kept on screen past midnight looks exactly like this to the app.
 */
export function buildForecast(date: string, paid: boolean, now: number, stale = false): Forecast {
  const day = stale ? dayBefore(date) : date;
  const generatedAt = new Date(now).toISOString();
  if (!paid) return { date: day, text: SHORT_TEXT, focus: null, is_paid: false, generated_at: generatedAt };
  // A focus per day of the month, so every label can be seen without waiting for a model to pick it.
  const focus = FOCUSES[Number(day.slice(8, 10)) % FOCUSES.length] ?? null;
  return { date: day, text: FULL_TEXT, focus, is_paid: true, generated_at: generatedAt };
}

/** The limits of the contract for a question, counted after trimming. */
const QUESTION_LENGTH = { min: 3, max: 500 } as const;

/** Topics apps/api does not answer on (`ask-topics.ts`), a few words of each: enough to see a soft refusal. */
const FORBIDDEN: readonly { pattern: RegExp; where: string }[] = [
  // «иск в суд», not a bare «суд»: as in apps/api, so that «судьба» is an ordinary question here too.
  { pattern: /юрист|адвокат|иск в суд|судебн|налог|наследств/iu, where: 'С этим — к юристу.' },
  { pattern: /разбогате|инвестиц|акци[ия]|крипт|казин/iu, where: 'Про гарантии дохода и инвестиции я не рассказываю: это не астрология.' },
  { pattern: /диагноз|болезн|здоровь|врач|смерт|умр[уёе]|беременн/iu, where: 'С этим — к врачу, и как можно скорее, если вопрос срочный.' },
];

/** The words of apps/api for a topic it does not take (`softRefusal`). */
const softRefusal = (where: string) =>
  `Про это я не могу: здоровье, смерть, гарантии денег и юридические вопросы — не моя роль. ${where} А про свою карту спрашивай смело — про ритм, отношения, работу, выбор.`;

const ANSWER =
  'Это ответ мока, а не чтение твоей карты: настоящий пишет сервер. Опора у тебя — в привычке доводить начатое до результата; когда выбор неочевиден, она помогает больше, чем скорость.';

/** What a question does besides being answered, by its first word: the failures worth seeing. */
export type AskScenario = 'error' | 'cap' | 'payment';

const SCENARIO_WORDS: readonly [word: string, scenario: AskScenario][] = [
  ['ошибка', 'error'],
  ['лимит', 'cap'],
  ['оплата', 'payment'],
];

export type AskOutcome =
  /** The body is not what the contract asks for: 422 with these fields. */
  | { kind: 'invalid'; errors: [FieldError, ...FieldError[]] }
  /** The first word of the question asks for a failure. */
  | { kind: 'scenario'; chartId: string; scenario: AskScenario }
  /** The day's questions are used up: 429 `QUOTA_EXCEEDED`. */
  | { kind: 'exhausted'; chartId: string }
  /** 200. `counted`: the answer costs one of the day's questions (a soft refusal costs none). */
  | { kind: 'answer'; chartId: string; body: Omit<AskResponse, 'quota'>; counted: boolean };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

/** The body of a question as the contract asks for it, or the fields apps/api would name (`engagement.dto.ts`), with its words. */
function readAsk(body: unknown): { chartId: string; question: string } | [FieldError, ...FieldError[]] {
  const chartId = isRecord(body) && typeof body.chart_id === 'string' && UUID.test(body.chart_id) ? body.chart_id : null;
  const question = isRecord(body) && typeof body.question === 'string' ? body.question.trim() : null;
  const fits = question !== null && question.length >= QUESTION_LENGTH.min && question.length <= QUESTION_LENGTH.max;
  if (chartId !== null && question !== null && fits) return { chartId, question };
  const badQuestion: FieldError = { field: 'question', message: 'Вопрос — от 3 до 500 знаков' };
  if (chartId !== null) return [badQuestion];
  const badChart: FieldError = { field: 'chart_id', message: 'chart_id — проверь значение' };
  return fits ? [badChart] : [badChart, badQuestion];
}

/**
 * `POST /engagement/ask` in the order apps/api checks things: the body, then the topic
 * (before the quota: a refusal costs nothing), then the quota. Whether the chart is the
 * user's is for the caller to check, right after the body, as on the server.
 */
export function askOutcome(body: unknown, quota: Pick<Quota, 'used' | 'limit'>, basedOn: string[]): AskOutcome {
  const read = readAsk(body);
  if (Array.isArray(read)) return { kind: 'invalid', errors: read };
  const { chartId } = read;

  const text = read.question.toLowerCase();
  const scenario = SCENARIO_WORDS.find(([word]) => text.startsWith(word))?.[1];
  if (scenario) return { kind: 'scenario', chartId, scenario };

  const forbidden = FORBIDDEN.find(({ pattern }) => pattern.test(text));
  if (forbidden) return { kind: 'answer', chartId, body: { answer: softRefusal(forbidden.where), based_on: [] }, counted: false };
  if (quota.limit >= 0 && quota.used >= quota.limit) return { kind: 'exhausted', chartId };
  return { kind: 'answer', chartId, body: { answer: ANSWER, based_on: basedOn }, counted: true };
}
