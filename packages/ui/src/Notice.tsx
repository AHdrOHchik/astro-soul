import type { ReactNode } from 'react';
import { cx } from './cx';
import { AlertIcon, InfoIcon } from './icons';
import styles from './Notice.module.css';

export interface NoticeProps {
  children: ReactNode;
  tone?: 'info' | 'warning';
  /** Lets another element name the notice as its description (`aria-describedby`). */
  id?: string;
}

/** Inline explanation that stays on screen (not a toast). */
export function Notice({ children, tone = 'info', id }: NoticeProps) {
  return (
    <div id={id} className={cx(styles.notice, styles[tone])} role="note">
      {tone === 'warning' ? <AlertIcon /> : <InfoIcon />}
      <p className={styles.text}>{children}</p>
    </div>
  );
}
