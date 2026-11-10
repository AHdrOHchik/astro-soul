import { Children } from 'react';
import type { ReactNode } from 'react';
import styles from './StateView.module.css';

export interface StateViewProps {
  title: string;
  text?: string;
  icon?: ReactNode;
  /** Small print under the actions, e.g. a support reference. */
  caption?: string;
  /** Action buttons. */
  children?: ReactNode;
  /** `alert` for errors (announced immediately), `status` for empty states. */
  role?: 'alert' | 'status';
}

/** Full-block message for the empty and error states of a screen. */
export function StateView({ title, text, icon, caption, children, role = 'status' }: StateViewProps) {
  // Callers pass conditional buttons; `false` and `null` must not leave an empty row behind.
  const hasActions = Children.toArray(children).length > 0;
  return (
    <div className={styles.state}>
      <div className={styles.message} role={role}>
        {icon && <span className={styles.icon}>{icon}</span>}
        <h2 className={styles.title}>{title}</h2>
        {text && <p className={styles.text}>{text}</p>}
      </div>
      {hasActions && <div className={styles.actions}>{children}</div>}
      {caption && <p className={styles.caption}>{caption}</p>}
    </div>
  );
}
