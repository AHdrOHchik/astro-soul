import { useRef } from 'react';
import type { ClipboardEvent, KeyboardEvent } from 'react';
import { cx } from './cx';
import styles from './SegmentedInput.module.css';

export interface Segment {
  id: string;
  /** Accessible name of the field, e.g. "Day". */
  label: string;
  placeholder: string;
  /** How many digits the field holds. */
  length: number;
  /** Highest valid number. Lets "4" in a day field become "04" and move on. */
  max?: number;
  autoComplete?: string;
}

export type SegmentValues = Readonly<Record<string, string>>;

export interface SegmentedInputProps {
  segments: readonly Segment[];
  values: SegmentValues;
  onChange: (values: Record<string, string>) => void;
  separator: string;
  invalid?: boolean;
  /** Focuses the first unfinished field on mount. */
  autoFocus?: boolean;
  labelledBy?: string;
  describedBy?: string;
}

const digitsOf = (raw: string) => raw.replace(/\D/g, '');

function normalise(segment: Segment, raw: string): string {
  const digits = digitsOf(raw).slice(0, segment.length);
  const cannotGrow = segment.max !== undefined && digits.length === 1 && Number(digits) * 10 > segment.max;
  return cannotGrow ? digits.padStart(segment.length, '0') : digits;
}

/** Numeric fields for dates and times: digits only, auto-advance, paste of a whole value. */
export function SegmentedInput({
  segments,
  values,
  onChange,
  separator,
  invalid,
  autoFocus,
  labelledBy,
  describedBy,
}: SegmentedInputProps) {
  const inputs = useRef<(HTMLInputElement | null)[]>([]);
  // True while this component moves focus itself, see handleBlur.
  const movingFocus = useRef(false);
  const valueOf = (segment: Segment) => values[segment.id] ?? '';
  const firstUnfinished = segments.findIndex((segment) => valueOf(segment).length < segment.length);

  const focusField = (index: number) => {
    const element = inputs.current[index];
    if (!element) return;
    movingFocus.current = true;
    element.focus();
    movingFocus.current = false;
  };

  const handleChange = (index: number, segment: Segment, raw: string) => {
    const value = normalise(segment, raw);
    onChange({ ...values, [segment.id]: value });
    if (value.length === segment.length) focusField(index + 1);
  };

  const handleBlur = (segment: Segment) => {
    // Our own focus moves happen before the parent re-renders: `values` is stale
    // there and padding would overwrite what was just typed or pasted.
    if (movingFocus.current) return;
    const value = valueOf(segment);
    if (segment.max !== undefined && value !== '' && value.length < segment.length) {
      onChange({ ...values, [segment.id]: value.padStart(segment.length, '0') });
    }
  };

  const handleKeyDown = (index: number, event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Backspace' && event.currentTarget.value === '') focusField(index - 1);
  };

  const handlePaste = (index: number, segment: Segment, event: ClipboardEvent<HTMLInputElement>) => {
    let rest = digitsOf(event.clipboardData.getData('text'));
    if (rest.length <= segment.length) return;
    // A whole value ("17.05.1994") was pasted: spread it over the following fields.
    event.preventDefault();
    const next: Record<string, string> = { ...values };
    let last = index;
    for (let i = index; i < segments.length && rest !== ''; i += 1) {
      const target = segments[i];
      if (!target) break;
      next[target.id] = rest.slice(0, target.length);
      rest = rest.slice(target.length);
      last = i;
    }
    onChange(next);
    focusField(last);
  };

  return (
    <div className={styles.group} role="group" aria-labelledby={labelledBy} aria-describedby={describedBy}>
      {segments.map((segment, index) => (
        <span key={segment.id} className={cx(styles.cell, segment.length > 2 && styles.wide)}>
          {index > 0 && (
            <span className={styles.separator} aria-hidden="true">
              {separator}
            </span>
          )}
          <input
            ref={(element) => {
              inputs.current[index] = element;
            }}
            className={cx(styles.input, invalid && styles.invalid)}
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            maxLength={segment.length}
            autoComplete={segment.autoComplete ?? 'off'}
            enterKeyHint={index === segments.length - 1 ? 'done' : 'next'}
            // The screen was opened by a tap, so focusing here is expected and saves one more tap.
            autoFocus={autoFocus && index === firstUnfinished}
            aria-label={segment.label}
            aria-invalid={invalid || undefined}
            placeholder={segment.placeholder}
            value={valueOf(segment)}
            onChange={(event) => {
              handleChange(index, segment, event.target.value);
            }}
            onBlur={() => {
              handleBlur(segment);
            }}
            onKeyDown={(event) => {
              handleKeyDown(index, event);
            }}
            onPaste={(event) => {
              handlePaste(index, segment, event);
            }}
          />
        </span>
      ))}
    </div>
  );
}
