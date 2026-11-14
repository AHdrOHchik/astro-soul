import { Button, FieldMessage, Notice, Screen, ScreenHeading, Skeleton, SkeletonGroup, TextArea, VisuallyHidden, type ScreenProps } from '@astro-soul/ui';
import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { trackRejection, type Track } from '../../analytics';
import {
  failureCodeOf,
  isAbortError,
  isApiError,
  QUESTION_MAX_LENGTH,
  rejectionTextOf,
  resetAtOf,
  serverTextOf,
  type AskAnswer,
  type Api,
  type Quota,
} from '../../api';
import { Reference } from '../../components/Reference';
import { SubscriptionHint } from '../../components/SubscriptionHint';
import { formatMoment, pluralForm } from '../../i18n/format';
import { ru } from '../../i18n/ru';
import { isDeviceMidnight } from '../../lib/localDay';
import styles from './AskScreen.module.css';

const copy = ru.ask;
const SKELETON_LINES = [0, 1, 2];

export interface AskScreenProps {
  api: Pick<Api, 'ask'>;
  /** The chart the question is about. */
  chartId: string;
  /**
   * The day's questions as the server's `Me.quotas` has them (`ask_daily`); null when it
   * names no such quota. The only source of the counter: the screen never counts by itself.
   */
  quota: Quota | null;
  /**
   * Asks the server for `Me` anew: as the screen opens and after every question sent. The
   * caller keeps the answer, and `quota` follows it.
   */
  refreshMe: (signal?: AbortSignal) => Promise<unknown>;
  track: Track;
  back?: ScreenProps['back'];
  /**
   * The quiet way to the subscriptions. Absent where there is none to offer (the user has
   * one, or this build sells none): then nothing here speaks of a subscription.
   */
  onSubscribe?: () => void;
  /** The server has no such chart (404): it went with the user's data. The caller leads on from there. */
  onChartGone: () => void;
}

/** The question on screen with the answer it got. One pair, in memory only: the next question takes its place. */
interface Exchange {
  question: string;
  answer: AskAnswer;
}

/** `429 QUOTA_EXCEEDED` to a question: when the limit lifts and what the server said, as far as it said either. */
interface Refusal {
  resetAt: Date | undefined;
  text: string | undefined;
  /** What the refusal is called in an event, when it turns out not to be the user's own limit. */
  code: string;
}

/**
 * What the screen knows of the day's count:
 *  - `asking`: `Me` is being asked, nothing is shown yet;
 *  - `fresh`: `quota` is the server's answer of a moment ago;
 *  - `unknown`: the server could not be asked. What the app heard before may be another
 *    day's count, or miss the question just answered: no number is shown, and nothing is
 *    decided by one. The server still counts, and says so when the limit is reached.
 */
type Count = 'asking' | 'fresh' | 'unknown';

/** How many questions `Me` says are left today; null for a quota that is not a count (no limit, no quota, a plan without questions). */
function leftOf(quota: Quota | null): number | null {
  return quota !== null && quota.limit > 0 ? Math.max(0, quota.limit - quota.used) : null;
}

/**
 * Whether the screen that started the work has been left. A function, so that every call
 * reads the signal anew: a property checked once is taken by the compiler for settled.
 */
const isOver = (signal: AbortSignal): boolean => signal.aborted;

function momentOf(iso: string): Date | undefined {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/**
 * The question screen: a question about the chart and the server's answer to it.
 *
 * Every question that reaches the server may cost one of the day's few, so one tap is one
 * request: the lock below is taken before anything is sent. What the answer says is the
 * server's business entirely. A refusal to speak on a topic arrives as an answer and is
 * shown as one, word for word; a used-up limit is a state of the day, not a failure.
 */
export function AskScreen({ api, chartId, quota, refreshMe, track, back, onSubscribe, onChartGone }: AskScreenProps) {
  const titleId = useId();
  const answerId = useId();
  const counterId = useId();
  const messageId = useId();
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const [exchange, setExchange] = useState<Exchange | null>(null);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const [count, setCount] = useState<Count>('asking');

  /**
   * True from the tap until its answer. A ref, not state and not the button's `disabled`:
   * those change with the next render, and a second tap can be handled before it.
   */
  const sending = useRef(false);
  const answerTitle = useRef<HTMLHeadingElement>(null);

  // The callbacks of the moment, for what must not start over when the caller renders.
  const latest = useRef({ refreshMe, onChartGone, track });
  useEffect(() => {
    latest.current = { refreshMe, onChartGone, track };
  });

  /** Asks the server for `Me`, where the count is. Never rejects: a count that could not be asked for is `unknown`. */
  const askCount = useCallback(async (signal: AbortSignal): Promise<void> => {
    const next: Count = await latest.current.refreshMe(signal).then(
      () => 'fresh',
      () => 'unknown',
    );
    if (!signal.aborted) setCount(next);
  }, []);

  // Ends everything the screen started when it is left.
  const life = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    life.current = controller;
    // The counter is shown before anything is sent, and it is the server's number of this minute.
    void askCount(controller.signal);
    return () => {
      controller.abort();
    };
  }, [askCount]);

  const left = leftOf(quota);
  // By the server's own count nothing is left for today. Believed only while that count is fresh.
  const usedUp = count === 'fresh' && left === 0;
  // The count the app heard before says «none left», and the server is being asked whether that still stands.
  // The old number is not shown and refuses nothing, but the form waits for the answer: a field that is gone
  // a moment after the user has tapped into it is worse than a placeholder.
  const held = count === 'asking' && left === 0 && !busy;
  // The server refused a question for the limit, and `Me` does not say the day's questions are used up.
  // Nothing then is said about midnight or a subscription, only what the server said.
  const refusedOtherwise = refusal !== null && !usedUp;
  // Refused for the limit while `Me`, asked a moment ago, counts questions left: the limit is not this user's own.
  const refusedByService = refusedOtherwise && count === 'fresh';

  // Once per opening of the screen: the day's questions are used up. By the server's count; or by its
  // refusal alone, when the count could not be asked for and the refusal is all there is to go by.
  const exhausted = usedUp || (refusal !== null && count === 'unknown');
  const counted = useRef(false);
  const countExhausted = () => {
    if (counted.current) return;
    counted.current = true;
    latest.current.track('quota_exhausted', { step: 'ask' });
  };
  useEffect(() => {
    if (exhausted) countExhausted();
  }, [exhausted]);
  // A limit of the service is not the user's quota and is not counted as one: the question simply got no answer.
  const refusalCode = refusedByService ? refusal.code : null;
  useEffect(() => {
    if (refusalCode !== null) latest.current.track('error_shown', { screen: 'ask', code: refusalCode });
  }, [refusalCode, refusal]);

  // A new answer is announced and brought into view: the field it was typed in may be below it.
  useEffect(() => {
    if (exchange === null) return;
    answerTitle.current?.focus({ preventScroll: true });
    answerTitle.current?.scrollIntoView({ block: 'nearest' });
  }, [exchange]);

  /** Sends the question and settles what the screen shows next. The caller holds the lock. */
  const send = async (text: string, signal: AbortSignal) => {
    setBusy(true);
    setFailure(null);
    setRefusal(null);
    // A new question takes the place of the previous one, and of its answer.
    setExchange(null);

    let refused: Refusal | null = null;
    try {
      const answer = await api.ask({ chart_id: chartId, question: text }, signal);
      if (signal.aborted) return;
      latest.current.track('ask_used');
      setExchange({ question: text, answer });
      setQuestion('');
    } catch (error) {
      if (signal.aborted || isAbortError(error)) return;
      const code = isApiError(error) ? error.code : 'INTERNAL';
      if (code === 'NOT_FOUND') {
        // The chart is not there any more. Not a failure of this screen to show: the app leads on, and says nothing of the server's.
        setBusy(false);
        latest.current.onChartGone();
        return;
      }
      if (code === 'QUOTA_EXCEEDED') {
        refused = { resetAt: resetAtOf(error), text: serverTextOf(error), code: failureCodeOf(error) };
      } else {
        if (!isApiError(error)) console.error(error);
        trackRejection(latest.current.track, 'ask', error);
        latest.current.track('error_shown', { screen: 'ask', code: failureCodeOf(error) });
        setFailure(error);
      }
    }

    // What is left now is the server's to say: after an answer, and after a question that may or may not have been counted.
    setCount('asking');
    const fresh = askCount(signal);
    // After a refusal the count comes first: it decides what the refusal is shown as.
    if (refused !== null) await fresh;
    if (isOver(signal)) return;
    setRefusal(refused);
    setBusy(false);
  };

  const submit = async () => {
    const text = question.trim();
    const signal = life.current?.signal;
    // The lock is checked first and taken before anything is sent: a second tap leaves here, with no request made.
    if (sending.current || usedUp || held || text === '' || signal === undefined) return;
    sending.current = true;
    try {
      await send(text, signal);
    } finally {
      sending.current = false;
    }
  };

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    void submit();
  };

  const rejected = isApiError(failure) && failure.code === 'VALIDATION_FAILED';
  const failureCode = isApiError(failure) ? failure.code : 'INTERNAL';
  const requestId = isApiError(failure) ? failure.requestId : undefined;
  const fieldError = rejected ? (rejectionTextOf(failure) ?? copy.rejected) : undefined;
  const length = question.length;

  return (
    <form className={styles.form} noValidate onSubmit={handleSubmit}>
      <Screen
        labelledBy={titleId}
        back={back}
        busy={busy}
        footer={
          usedUp || held ? undefined : (
            <Button type="submit" disabled={busy || question.trim() === ''}>
              {busy ? copy.sending : copy.submit}
            </Button>
          )
        }
      >
        <div className={styles.content}>
          <ScreenHeading id={titleId} title={copy.title} focusOnMount />

          {busy && (
            <SkeletonGroup label={copy.sending} className={styles.skeleton}>
              {SKELETON_LINES.map((line) => (
                <Skeleton key={line} />
              ))}
            </SkeletonGroup>
          )}

          {exchange !== null && (
            <section className={styles.exchange} aria-labelledby={answerId}>
              <div className={styles.asked}>
                <p className={styles.caption}>{copy.asked}</p>
                <p className={styles.plain}>{exchange.question}</p>
              </div>
              <h2 id={answerId} ref={answerTitle} className={styles.subtitle} tabIndex={-1}>
                {copy.answer}
              </h2>
              {/* The server's words as they came, whatever they say: an answer, or why there is none on this topic. */}
              <p className={styles.plain}>{exchange.answer.answer}</p>
              {exchange.answer.based_on.length > 0 && (
                <div className={styles.basis}>
                  <h3 className={styles.caption}>{copy.basedOn}</h3>
                  <ul className={styles.basisList}>
                    {exchange.answer.based_on.map((item, index) => (
                      // The server may name one position twice: the place in the list tells them apart.
                      <li key={`${String(index)}:${item}`} className={styles.basisItem}>
                        {item}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </section>
          )}

          {usedUp ? (
            <Exhausted resetAt={refusal?.resetAt ?? (quota ? momentOf(quota.reset_at) : undefined)} onSubscribe={onSubscribe} />
          ) : held ? (
            <SkeletonGroup label={ru.common.loading} className={styles.skeleton}>
              {SKELETON_LINES.map((line) => (
                <Skeleton key={line} />
              ))}
            </SkeletonGroup>
          ) : (
            <div className={styles.field}>
              <QuotaLine quota={quota} count={count} />
              <TextArea
                label={copy.fieldLabel}
                placeholder={copy.placeholder}
                value={question}
                maxLength={QUESTION_MAX_LENGTH}
                readOnly={busy}
                aria-invalid={fieldError !== undefined || undefined}
                aria-describedby={`${counterId} ${messageId}`}
                onChange={(value) => {
                  setQuestion(value.slice(0, QUESTION_MAX_LENGTH));
                  // What the server said was about the question as it was.
                  if (rejected) setFailure(null);
                }}
              />
              <div className={styles.below}>
                <FieldMessage id={messageId} error={fieldError} />
                <p id={counterId} className={styles.counter}>
                  <span aria-hidden="true">{copy.counter(length, QUESTION_MAX_LENGTH)}</span>
                  <VisuallyHidden>{copy.counterLabel(length, QUESTION_MAX_LENGTH)}</VisuallyHidden>
                </p>
              </div>
              {rejected && requestId && <Reference value={requestId} label={ru.common.requestId(requestId)} />}
              {refusedOtherwise && (
                // The limit that stopped the question is not the user's own count: the server's words, and nothing added to them.
                <div role="status">
                  <Notice>{refusal.text ?? ru.errors.QUOTA_EXCEEDED.text}</Notice>
                </div>
              )}
              {failure !== null && !rejected && (
                <div className={styles.problem} role="alert">
                  <Notice tone="warning">
                    <strong>{copy.failedTitle}.</strong> {serverTextOf(failure) ?? ru.errors[failureCode].text}
                  </Notice>
                  {requestId && <Reference value={requestId} label={ru.common.requestId(requestId)} />}
                </div>
              )}
            </div>
          )}
        </div>
      </Screen>
    </form>
  );
}

/** How many questions are left today, by `Me.quotas`. Nothing for a quota that has no words here, and for a count nobody vouches for. */
function QuotaLine({ quota, count }: { quota: Quota | null; count: Count }) {
  if (count === 'asking') {
    return (
      <SkeletonGroup label={ru.common.loading}>
        <Skeleton className={styles.quotaSkeleton} />
      </SkeletonGroup>
    );
  }
  if (count === 'unknown' || quota === null) return null;
  // -1 is «no limit», never a number on screen.
  if (quota.limit < 0) return <p className={styles.quota}>{copy.unlimited}</p>;
  const left = leftOf(quota);
  if (left === null) return null;
  return <p className={styles.quota}>{copy.left(left, quota.limit, pluralForm(left))}</p>;
}

interface ExhaustedProps {
  /** When the day's questions come back, if the server said. */
  resetAt: Date | undefined;
  onSubscribe?: () => void;
}

/** The day's questions are used up. Said calmly, as a state of the day: when new ones come, and what a subscription changes. */
function Exhausted({ resetAt, onSubscribe }: ExhaustedProps) {
  const when = resetAt ? formatMoment(resetAt) : '';
  return (
    <div className={styles.exhausted}>
      <div className={styles.exhaustedText} role="status">
        <p>{copy.exhausted}</p>
        {resetAt && when !== '' && (
          <p className={styles.muted}>
            {copy.resets(when)}
            {/* The midnight is the birth place's. Where the user's own clock shows another hour for it, that is said. */}
            {!isDeviceMidnight(resetAt) && ` ${copy.resetsElsewhere}`}
          </p>
        )}
      </div>
      {onSubscribe && <SubscriptionHint text={copy.subscriptionOffer} onOpen={onSubscribe} />}
    </div>
  );
}
