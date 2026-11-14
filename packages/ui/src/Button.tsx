import { forwardRef } from 'react';
import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactNode } from 'react';
import styles from './Button.module.css';
import { cx } from './cx';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className' | 'style'> {
  /** `danger` is for an action that cannot be undone, and for the steps that lead to it. */
  variant?: Variant;
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

export interface ButtonLinkProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'className' | 'style'> {
  href: string;
  variant?: Exclude<Variant, 'danger'>;
  icon?: ReactNode;
}

/** A link that looks and measures like `Button`: for an address the client itself has to follow. */
export function ButtonLink({ variant = 'secondary', icon, children, ...rest }: ButtonLinkProps) {
  return (
    <a className={cx(styles.button, styles[variant])} {...rest}>
      {icon && <span className={styles.icon}>{icon}</span>}
      {children}
    </a>
  );
}
