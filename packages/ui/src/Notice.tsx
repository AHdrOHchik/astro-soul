import type { ReactNode } from 'react';
import { cx } from './cx';
import { AlertIcon, InfoIcon } from './icons';
import styles from './Notice.module.css';

export interface NoticeProps {
  children: ReactNode;
  tone?: 'info' | 'warning';
}

/** Inline explanation that stays on screen (not a toast). */
export function Notice({ children, tone = 'info' }: NoticeProps) {
  return (
    <div className={cx(styles.notice, styles[tone])} role="note">
      {tone === 'warning' ? <AlertIcon /> : <InfoIcon />}
      <p className={styles.text}>{children}</p>
    </div>
  );
}
