import { Button, Card, LockIcon } from '@astro-soul/ui';
import { useId } from 'react';
import { ru } from '../../i18n/ru';
import styles from './Teaser.module.css';

const copy = ru.chart;
const HIDDEN_LINES = [0, 1, 2];

export interface TeaserProps {
  /** `mini_reading.summary`: the only report text the chart response carries. */
  summary?: string;
}

/**
 * Locked preview of the full report: three lines of the summary, then a blurred
 * stand-in for the rest. The stand-in is shapes, not text: nothing unpaid is in
 * the DOM to be read around the blur.
 *
 * Iteration 1 has no purchase flow, and the price can only come from the server
 * (`POST /billing/invoice`), so the button is disabled and shows no price.
 */
export function Teaser({ summary }: TeaserProps) {
  const titleId = useId();
  const noteId = useId();
  return (
    <Card labelledBy={titleId}>
      <div className={styles.teaser}>
        <h2 id={titleId} className={styles.title}>
          {copy.teaserTitle}
        </h2>
        {summary && <p className={styles.summary}>{summary}</p>}
        <div className={styles.locked}>
          <div className={styles.hidden} aria-hidden="true">
            {HIDDEN_LINES.map((line) => (
              <span key={line} className={styles.line} />
            ))}
          </div>
          <p className={styles.badge}>
            <LockIcon />
            <span className={styles.badgeText}>{copy.teaserLocked}</span>
          </p>
        </div>
        <Button disabled aria-describedby={noteId}>
          {copy.teaserCta}
        </Button>
        <p id={noteId} className={styles.note}>
          {copy.teaserSoon}
        </p>
      </div>
    </Card>
  );
}
