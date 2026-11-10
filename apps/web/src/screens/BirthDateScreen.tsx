import { FieldMessage, SegmentedInput, Stack, type ScreenProps, type Segment } from '@astro-soul/ui';
import { useEffect, useId, useRef, useState } from 'react';
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
  /** The device's current day: the reference for the 18+ check. */
  today: Date;
  back?: ScreenProps['back'];
  onChange: (value: DateParts) => void;
  onNext: () => void;
}

/** Screen 2. Calendar and 18+ validation happen as soon as the date is complete. */
export function BirthDateScreen({ value, today, back, onChange, onNext }: BirthDateScreenProps) {
  const messageId = useId();
  const field = useRef<HTMLDivElement>(null);
  const submit = useRef<HTMLButtonElement>(null);
  const [submitted, setSubmitted] = useState(false);

  const check = checkBirthDate(value, today);
  // A date that is still being typed is not an error until the user tries to go on.
  const issue = check.ok || (check.issue === 'incomplete' && !submitted) ? null : check.issue;

  // "Typed" matters: 17.1.1994 is already a valid date while the user is on the way to 17.12.1994.
  const finished = check.ok && isDateTyped(value);
  useEffect(() => {
    // The last digit completed a valid date: hand focus to the button, which also folds the keyboard away.
    if (finished && field.current?.contains(document.activeElement)) submit.current?.focus();
  }, [finished]);

  const handleSubmit = () => {
    if (check.ok) {
      onNext();
      return;
    }
    setSubmitted(true);
    focusFirstOpenInput(field.current);
  };

  return (
    <StepScreen step={1} title={copy.title} hint={copy.hint} back={back} submitRef={submit} focusesField onSubmit={handleSubmit}>
      <Stack gap="sm">
        <div ref={field}>
          <SegmentedInput
            segments={SEGMENTS}
            values={value}
            separator="."
            invalid={issue !== null}
            autoFocus
            describedBy={messageId}
            onChange={(next) => {
              onChange({ day: next.day ?? '', month: next.month ?? '', year: next.year ?? '' });
            }}
          />
        </div>
        <FieldMessage id={messageId} error={issue && copy.issues[issue]} />
      </Stack>
    </StepScreen>
  );
}
