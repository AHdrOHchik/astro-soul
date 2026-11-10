import type { ReactNode } from 'react';
import { BackIcon } from './icons';
import styles from './Screen.module.css';

export interface ScreenProps {
  children: ReactNode;
  /** Sits above the scrolling body, e.g. a step indicator. */
  header?: ReactNode;
  /** Pinned to the bottom edge so the primary action never scrolls away. */
  footer?: ReactNode;
  /** In-app back control for clients without the native Telegram BackButton. */
  back?: { label: string; onClick: () => void };
  /** id of the heading that names the screen. */
  labelledBy?: string;
  busy?: boolean;
}

/** Page frame: max-width column, safe-area paddings, scrollable body, pinned footer. */
export function Screen({ children, header, footer, back, labelledBy, busy }: ScreenProps) {
  return (
    <div className={styles.screen}>
      {(back || header) && (
        <div className={styles.top}>
          {back && (
            <button type="button" className={styles.back} onClick={back.onClick}>
              <BackIcon />
              {back.label}
            </button>
          )}
          {header}
        </div>
      )}
      <main className={styles.body} aria-labelledby={labelledBy} aria-busy={busy || undefined}>
        {children}
      </main>
      {footer && <div className={styles.footer}>{footer}</div>}
    </div>
  );
}
