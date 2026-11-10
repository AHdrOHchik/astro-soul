import type { ReactNode } from 'react';
import { cx } from './cx';
import styles from './Stack.module.css';

export interface StackProps {
  children: ReactNode;
  gap?: 'xs' | 'sm' | 'md' | 'lg';
  className?: string;
}

/** Vertical rhythm. Grid `gap` (not flex gap) so it also works in older WebViews. */
export function Stack({ children, gap = 'md', className }: StackProps) {
  return <div className={cx(styles.stack, styles[gap], className)}>{children}</div>;
}
