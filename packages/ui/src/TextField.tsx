import { forwardRef, useId } from 'react';
import type { InputHTMLAttributes, ReactNode } from 'react';
import styles from './TextField.module.css';

export interface TextFieldProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, 'className' | 'style' | 'value' | 'onChange' | 'id'> {
  label: string;
  value: string;
  onChange: (value: string) => void;
  /** Decorative icon inside the field, before the text. */
  icon?: ReactNode;
}

export const TextField = forwardRef<HTMLInputElement, TextFieldProps>(function TextField(
  { label, value, onChange, icon, type = 'text', ...rest },
  ref,
) {
  const id = useId();
  return (
    <div className={styles.field}>
      <label className={styles.label} htmlFor={id}>
        {label}
      </label>
      <div className={styles.control}>
        {icon && <span className={styles.icon}>{icon}</span>}
        <input
          ref={ref}
          id={id}
          className={styles.input}
          type={type}
          value={value}
          onChange={(event) => {
            onChange(event.target.value);
          }}
          {...rest}
        />
      </div>
    </div>
  );
});
