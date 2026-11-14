import type { ReactNode, Ref } from 'react';
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
  /** A way out of the screen's own flow, in the top right corner, e.g. to the settings. */
  action?: { label: string; icon?: ReactNode; onClick: () => void };
  /** id of the heading that names the screen. */
  labelledBy?: string;
  busy?: boolean;
  /** The scrolling body, for a screen that has to put its scroll position back. */
  bodyRef?: Ref<HTMLElement>;
}

/** Page frame: max-width column, safe-area paddings, scrollable body, pinned footer. */
export function Screen({ children, header, footer, back, action, labelledBy, busy, bodyRef }: ScreenProps) {
  return (
    <div className={styles.screen}>
      {(back || action || header) && (
        <div className={styles.top}>
          {(back || action) && (
            <div className={styles.bar}>
              {back && (
                <button type="button" className={styles.back} onClick={back.onClick}>
                  <BackIcon />
                  {back.label}
                </button>
              )}
              {action && (
                <button type="button" className={styles.action} onClick={action.onClick}>
                  {action.icon}
                  <span className={styles.actionLabel}>{action.label}</span>
                </button>
              )}
            </div>
          )}
          {header}
        </div>
      )}
      <main ref={bodyRef} className={styles.body} aria-labelledby={labelledBy} aria-busy={busy || undefined}>
        {children}
      </main>
      {footer && <div className={styles.footer}>{footer}</div>}
    </div>
  );
}
