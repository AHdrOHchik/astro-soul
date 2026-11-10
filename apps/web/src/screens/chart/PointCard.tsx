import { Card } from '@astro-soul/ui';
import { useId } from 'react';
import type { ReactNode } from 'react';
import styles from './PointCard.module.css';

export interface PointCardProps {
  icon: ReactNode;
  /** Name of the point: the Sun, the Moon or the Ascendant. */
  title: string;
  /** Sign, degrees and minutes as one string; null when there is no position to show. */
  position: string | null;
  /** Shown in place of a missing position. */
  fallback: string;
  /** Secondary fact next to the position, e.g. the house. */
  detail?: string;
  /** Reading for this point. */
  text?: string;
}

/** One of the three headline points of the chart. */
export function PointCard({ icon, title, position, fallback, detail, text }: PointCardProps) {
  const titleId = useId();
  return (
    <Card labelledBy={titleId}>
      <div className={styles.head}>
        <span className={styles.icon}>{icon}</span>
        <div className={styles.headText}>
          <h3 id={titleId} className={styles.title}>
            {title}
          </h3>
          {position === null ? (
            <p className={styles.fallback}>{fallback}</p>
          ) : (
            <p className={styles.position}>
              {position}
              {detail && <span className={styles.detail}> · {detail}</span>}
            </p>
          )}
        </div>
      </div>
      {text && <p className={styles.text}>{text}</p>}
    </Card>
  );
}
