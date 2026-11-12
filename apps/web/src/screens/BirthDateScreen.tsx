import { FieldMessage, SegmentedInput, Stack, type ScreenProps, type Segment } from '@astro-soul/ui';
import { useEffect, useId, useRef, useState } from 'react';
import type { Track } from '../analytics';
import { useClientCheck } from '../hooks/useClientCheck';
import { ru } from '../i18n/ru';
import { checkBirthDate, isDateTyped, type DateParts } from '../lib/birth';
import { focusFirstOpenInput } from '../lib/focus';
import { StepScreen } from './StepScreen';

const copy = ru.birthDate;

const SEGMENTS: readonly Segment[] = [
  { id: 'day', label: copy.day, placeholder: copy.dayPlaceholder, length: 2, max: 31, autoComplete: 'bday-day' },
  { id: 'month', label: copy.month, placeholder: copy.monthPlaceholder, length: 2, max: 12, autoComplete: 'bday-month' },
  { id: 'year', label: copy.year, placeholder: copy.yearPlaceholder, length: 4, autoComplete: 'bday-year' },
];

export interface BirthDateScreenProps {
  value: DateParts;
  /** The current moment: the reference for the 18+ check, which reads its UTC day (see `checkBirthDate`). */
  today: Date;
  /** The server's text about this date, when it rejected the chart request. Its checks are the ones that count. */
  serverError?: string;
  /** Reports that a check of this screen stopped the user; never the date or what was wrong with it. */
  track: Track;
  back?: ScreenProps['back'];
  onChange: (value: DateParts) => void;
  onNext: () => void;
}

/** Screen 2. Calendar and 18+ validation happen as soon as the date is complete. */
export function BirthDateScreen({ value, today, serverError, track, back, onChange, onNext }: BirthDateScreenProps) {
  const messageId = useId();
  const field = useRef<HTMLDivElement>(null);
  const submit = useRef<HTMLButtonElement>(null);
  const [submitted, setSubmitted] = useState(false);
  // Where focus goes is decided once, when the screen opens. Brought back by the server's verdict, the user
  // lands in the field it is about; an unfinished date gets the cursor; a finished one leaves focus to the title.
  const [rejectedAtStart] = useState(serverError !== undefined);
  const [typedAtStart] = useState(() => isDateTyped(value));
  useEffect(() => {
    if (rejectedAtStart) focusFirstOpenInput(field.current);
  }, [rejectedAtStart]);

  const check = checkBirthDate(value, today);
  // A date that is still being typed is not an error until the user tries to go on.
  const issue = check.ok || (check.issue === 'incomplete' && !submitted) ? null : check.issue;
  const error = issue ? copy.issues[issue] : serverError;
  useClientCheck(track, 'birth_date', 'birth_date', issue);

  // Counts the times typing completed a valid date. A count, not "the date is complete": a date
  // that is already complete when the screen opens is nobody's keystroke and must not move focus.
  const [completions, setCompletions] = useState(0);
  useEffect(() => {
    // After the render that shows the last digit: hand focus to the button, which also folds the keyboard away.
    if (completions > 0 && field.current?.contains(document.activeElement)) submit.current?.focus();
  }, [completions]);

  const handleSubmit = () => {
    if (check.ok) {
      onNext();
      return;
    }
    setSubmitted(true);
    focusFirstOpenInput(field.current);
  };

  return (
    <StepScreen
      step={1}
      title={copy.title}
      hint={copy.hint}
      back={back}
      submitRef={submit}
      focusesField={rejectedAtStart || !typedAtStart}
      onSubmit={handleSubmit}
    >
      <Stack gap="sm">
        <div ref={field}>
          <SegmentedInput
            segments={SEGMENTS}
            values={value}
            separator="."
            invalid={error !== undefined}
            autoFocus
            describedBy={messageId}
            onChange={(next) => {
              const date = { day: next.day ?? '', month: next.month ?? '', year: next.year ?? '' };
              onChange(date);
              // "Typed" matters: 17.1.1994 is already a valid date while the user is on the way to 17.12.1994.
              if (isDateTyped(date) && checkBirthDate(date, today).ok) setCompletions((count) => count + 1);
            }}
          />
        </div>
        <FieldMessage id={messageId} error={error} />
      </Stack>
    </StepScreen>
  );
}
