import { FieldMessage, Notice, OptionCard, SegmentedInput, Stack, type ScreenProps, type Segment } from '@astro-soul/ui';
import { useEffect, useId, useRef, useState } from 'react';
import { ru } from '../i18n/ru';
import { checkBirthTime, isTimeTyped, type TimeMode, type TimeParts } from '../lib/birth';
import { focusFirstOpenInput } from '../lib/focus';
import styles from './BirthTimeScreen.module.css';
import { StepScreen } from './StepScreen';

const copy = ru.birthTime;
const MODES: readonly TimeMode[] = ['exact', 'approx', 'unknown'];

const SEGMENTS: readonly Segment[] = [
  { id: 'hours', label: copy.hours, placeholder: copy.hoursPlaceholder, length: 2, max: 23 },
  { id: 'minutes', label: copy.minutes, placeholder: copy.minutesPlaceholder, length: 2, max: 59 },
];

export interface BirthTimeScreenProps {
  mode: TimeMode | null;
  time: TimeParts;
  back?: ScreenProps['back'];
  onModeChange: (mode: TimeMode) => void;
  onTimeChange: (time: TimeParts) => void;
  onNext: () => void;
}

/**
 * Screen 3. Three options; every one of them says plainly what it does to the
 * accuracy of the chart before the user moves on.
 */
export function BirthTimeScreen({ mode, time, back, onModeChange, onTimeChange, onNext }: BirthTimeScreenProps) {
  const optionsMessageId = useId();
  const timeLabelId = useId();
  const timeMessageId = useId();
  const groupName = useId();
  const field = useRef<HTMLDivElement>(null);
  const notice = useRef<HTMLDivElement>(null);
  const submit = useRef<HTMLButtonElement>(null);
  // Raised by a tap on an option, lowered once the note for that option is on the page.
  const noteIsNew = useRef(false);
  const [submitted, setSubmitted] = useState(false);

  const needsTime = mode === 'exact' || mode === 'approx';
  const check = checkBirthTime(time);
  const timeIssue = !needsTime || check.ok || (check.issue === 'incomplete' && !submitted) ? null : check.issue;
  const done = mode === 'unknown' || (needsTime && check.ok);

  // "Typed" matters: 14:3 is already a valid time while the user is on the way to 14:30.
  const finished = needsTime && check.ok && isTimeTyped(time);
  useEffect(() => {
    if (finished && field.current?.contains(document.activeElement)) submit.current?.focus();
  }, [finished]);

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
    <StepScreen step={2} title={copy.title} hint={copy.hint} back={back} submitRef={submit} onSubmit={handleSubmit}>
      <Stack gap="sm">
        <div
          className={styles.options}
          role="radiogroup"
          aria-label={copy.optionsLabel}
          aria-describedby={mode === null && submitted ? optionsMessageId : undefined}
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
        {mode === null && submitted && <FieldMessage id={optionsMessageId} error={copy.chooseOption} />}
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
              invalid={timeIssue !== null}
              autoFocus
              labelledBy={timeLabelId}
              describedBy={timeMessageId}
              onChange={(next) => {
                onTimeChange({ hours: next.hours ?? '', minutes: next.minutes ?? '' });
              }}
            />
          </div>
          <FieldMessage id={timeMessageId} error={timeIssue && copy.issues[timeIssue]} hint={copy.timeHint} />
        </Stack>
      )}
    </StepScreen>
  );
}
