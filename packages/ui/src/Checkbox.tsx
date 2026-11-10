import type { ReactNode } from 'react';
import styles from './Checkbox.module.css';
import { CheckIcon } from './icons';

export interface CheckboxProps {
  /** The box has no state of its own: it is ticked only while the caller says so. */
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** The label. Keep links and buttons out of it: a tap anywhere on the row toggles the box. */
  children: ReactNode;
  invalid?: boolean;
  /** id of the hint or error that describes the box. */
  describedBy?: string;
  /** Takes focus when the screen opens, e.g. when the user is brought back to the box by an error. */
  autoFocus?: boolean;
}

/** A native checkbox drawn as a large tappable row. */
export function Checkbox({ checked, onChange, children, invalid, describedBy, autoFocus }: CheckboxProps) {
  return (
    <label className={styles.option}>
      <input
        className={styles.input}
        type="checkbox"
        checked={checked}
        autoFocus={autoFocus}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        onChange={(event) => {
          onChange(event.target.checked);
        }}
      />
      <span className={styles.box}>
        <span className={styles.mark} aria-hidden="true">
          <CheckIcon />
        </span>
        <span className={styles.text}>{children}</span>
      </span>
    </label>
  );
}
