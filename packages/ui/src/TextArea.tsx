import { forwardRef, useId } from 'react';
import type { TextareaHTMLAttributes } from 'react';
import styles from './TextArea.module.css';

export interface TextAreaProps
  extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'className' | 'style' | 'value' | 'onChange' | 'id'> {
  label: string;
  value: string;
  onChange: (value: string) => void;
}

/**
 * A field for a few sentences. It keeps the height of its `rows`: a longer text scrolls
 * inside, so the screen under the field does not jump while the user types.
 */
export const TextArea = forwardRef<HTMLTextAreaElement, TextAreaProps>(function TextArea(
  { label, value, onChange, rows = 4, ...rest },
  ref,
) {
  const id = useId();
  return (
    <div className={styles.field}>
      <label className={styles.label} htmlFor={id}>
        {label}
      </label>
      <textarea
        ref={ref}
        id={id}
        className={styles.input}
        rows={rows}
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
        }}
        {...rest}
      />
    </div>
  );
});
