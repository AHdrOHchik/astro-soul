import { FieldMessage, Notice, OptionCard, SegmentedInput, Stack, type ScreenProps, type Segment } from '@astro-soul/ui';
import { useEffect, useId, useRef, useState } from 'react';
import type { Track } from '../analytics';
import type { TimePrecision } from '../api';
import { useClientCheck } from '../hooks/useClientCheck';
import { ru } from '../i18n/ru';
import { checkBirthTime, isTimeTyped, type TimeParts } from '../lib/birth';
import { focusChosenOption, focusFirstOpenInput } from '../lib/focus';
import styles from './BirthTimeScreen.module.css';
import { StepScreen } from './StepScreen';

const copy = ru.birthTime;
const MODES: readonly TimePrecision[] = ['exact', 'approximate', 'unknown'];

const SEGMENTS: readonly Segment[] = [
  { id: 'hours', label: copy.hours, placeholder: copy.hoursPlaceholder, length: 2, max: 23 },
  { id: 'minutes', label: copy.minutes, placeholder: copy.minutesPlaceholder, length: 2, max: 59 },
];

export interface BirthTimeScreenProps {
  mode: TimePrecision | null;
  time: TimeParts;
  /** The server's text about the chosen option (`time_precision`), when it rejected the chart request. */
  precisionError?: string;
  /** The same about the time itself (`birth_time`). */
  timeError?: string;
  /** Reports that a check of this screen stopped the user; never the time or what was wrong with it. */
  track: Track;
  back?: ScreenProps['back'];
  onModeChange: (mode: TimePrecision) => void;
  onTimeChange: (time: TimeParts) => void;
  onNext: () => void;
}

/**
 * Screen 3. Three options; every one of them says plainly what it does to the
 * accuracy of the chart before the user moves on.
 */
export function BirthTimeScreen({
  mode,
  time,
  precisionError,
  timeError,
  track,
  back,
  onModeChange,
  onTimeChange,
  onNext,
}: BirthTimeScreenProps) {
  const optionsMessageId = useId();
  const timeLabelId = useId();
  const timeMessageId = useId();
  const groupName = useId();
  const options = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLDivElement>(null);
  const notice = useRef<HTMLDivElement>(null);
  const submit = useRef<HTMLButtonElement>(null);
  // Raised by a tap on an option, lowered once the note for that option is on the page.
  const noteIsNew = useRef(false);
  const [submitted, setSubmitted] = useState(false);

  const needsTime = mode === 'exact' || mode === 'approximate';
  const check = checkBirthTime(time);
  const timeIssue = !needsTime || check.ok || (check.issue === 'incomplete' && !submitted) ? null : check.issue;
  const done = mode === 'unknown' || (needsTime && check.ok);
  const unchosen = mode === null && submitted;
  // What the server said about the time is shown at the time field; without one on screen, next to the options.
  const optionsError = unchosen ? copy.chooseOption : (precisionError ?? (needsTime ? undefined : timeError));
  const timeFieldError = timeIssue ? copy.issues[timeIssue] : timeError;
  useClientCheck(track, 'birth_time', 'time_precision', unchosen ? 'unchosen' : null);
  useClientCheck(track, 'birth_time', 'birth_time', timeIssue);

  // Decided once, when the screen opens: brought back by the server's verdict, the user lands on what it is about.
  const [rejectedAtStart] = useState<'options' | 'time' | null>(() => {
    if (precisionError !== undefined || (timeError !== undefined && !needsTime)) return 'options';
    return timeError === undefined ? null : 'time';
  });
  useEffect(() => {
    if (rejectedAtStart === 'options') focusChosenOption(options.current);
    if (rejectedAtStart === 'time') focusFirstOpenInput(field.current);
  }, [rejectedAtStart]);

  // Counts the times typing completed a valid time. A count, not "the time is complete": a time
  // that is already complete when the screen opens is nobody's keystroke and must not move focus.
  const [completions, setCompletions] = useState(0);
  useEffect(() => {
    // After the render that shows the last digit: hand focus to the button, which also folds the keyboard away.
    if (completions > 0 && field.current?.contains(document.activeElement)) submit.current?.focus();
  }, [completions]);

  useEffect(() => {
    if (!noteIsNew.current) return;
    noteIsNew.current = false;
    // With a time to enter, the focused field brings the note above it on screen. "Unknown" has
    // no field, and on a small phone the note would stay below the fold, unread.
    if (mode === 'unknown') notice.current?.scrollIntoView({ block: 'nearest' });
  }, [mode]);

  const handleSubmit = () => {
    if (done) {
      onNext();
      return;
    }
    setSubmitted(true);
    if (needsTime) focusFirstOpenInput(field.current);
  };

  return (
    <StepScreen
      step={2}
      title={copy.title}
      hint={copy.hint}
      back={back}
      submitRef={submit}
      focusesField={rejectedAtStart !== null}
      onSubmit={handleSubmit}
    >
      <Stack gap="sm">
        <div
          ref={options}
          className={styles.options}
          role="radiogroup"
          aria-label={copy.optionsLabel}
          aria-describedby={optionsError === undefined ? undefined : optionsMessageId}
        >
          {MODES.map((option) => (
            <OptionCard
              key={option}
              name={groupName}
              value={option}
              checked={mode === option}
              title={copy.options[option].title}
              description={copy.options[option].description}
              onSelect={(next) => {
                // A fresh choice starts clean: no "enter the time" error before the user had a chance to.
                setSubmitted(false);
                noteIsNew.current = true;
                onModeChange(next);
              }}
            />
          ))}
        </div>
        {optionsError !== undefined && <FieldMessage id={optionsMessageId} error={optionsError} />}
      </Stack>

      {/* Right under the choice and above the time field: the user reads it before typing. */}
      {mode !== null && (
        <div ref={notice}>
          <Notice tone={mode === 'exact' ? 'info' : 'warning'}>{copy.options[mode].accuracy}</Notice>
        </div>
      )}

      {needsTime && (
        <Stack gap="sm">
          <p id={timeLabelId} className={styles.label}>
            {copy.timeLabel}
          </p>
          <div ref={field}>
            <SegmentedInput
              segments={SEGMENTS}
              values={time}
              separator=":"
              invalid={timeFieldError !== undefined}
              autoFocus
              labelledBy={timeLabelId}
              describedBy={timeMessageId}
              onChange={(next) => {
                const typed = { hours: next.hours ?? '', minutes: next.minutes ?? '' };
                onTimeChange(typed);
                // "Typed" matters: 14:3 is already a valid time while the user is on the way to 14:30.
                if (isTimeTyped(typed) && checkBirthTime(typed).ok) setCompletions((count) => count + 1);
              }}
            />
          </div>
          <FieldMessage id={timeMessageId} error={timeFieldError} hint={copy.timeHint} />
        </Stack>
      )}
    </StepScreen>
  );
}
