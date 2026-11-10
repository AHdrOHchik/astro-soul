import type { ReactNode } from 'react';
import styles from './Card.module.css';
import { cx } from './cx';

export interface CardProps {
  children: ReactNode;
  className?: string;
  /** id of the heading that names the card; turns it into a labelled region. */
  labelledBy?: string;
}

export function Card({ children, className, labelledBy }: CardProps) {
  return (
    <section className={cx(styles.card, className)} aria-labelledby={labelledBy}>
      {children}
    </section>
  );
}
