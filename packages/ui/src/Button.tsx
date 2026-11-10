import { forwardRef } from 'react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import styles from './Button.module.css';
import { cx } from './cx';

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className' | 'style'> {
  variant?: 'primary' | 'secondary' | 'ghost';
  icon?: ReactNode;
}

/** Full-width action. Every variant is at least --size-tap (48px) tall. */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'primary', icon, type = 'button', children, ...rest },
  ref,
) {
  return (
    <button ref={ref} type={type} className={cx(styles.button, styles[variant])} {...rest}>
      {icon && <span className={styles.icon}>{icon}</span>}
      {children}
    </button>
  );
});
