import { priceOf } from '@astro-soul/shared';
import { Button, Card, LockIcon, VisuallyHidden } from '@astro-soul/ui';
import { useId } from 'react';
import { formatCount, pluralForm } from '../../i18n/format';
import { ru } from '../../i18n/ru';
import styles from './Teaser.module.css';

const copy = ru.chart;
const HIDDEN_LINES = [0, 1, 2];
/** The one-off purchase of the full report; prices live in packages/shared only (payments.md, section 1). */
const REPORT_PRICE = priceOf('one_149');

export interface TeaserProps {
  /** `mini_reading.summary`: the only report text the chart response carries. */
  summary?: string;
}

/**
 * Locked preview of the full report: three lines of the summary, then a blurred
 * stand-in for the rest. The stand-in is shapes, not text: nothing unpaid is in
 * the DOM to be read around the blur.
 *
 * Iteration 1 has no purchase flow, so the button names the price but is disabled.
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
          <span>
            {copy.teaserCta}{' '}
            <span className={styles.price}>
              {formatCount(REPORT_PRICE)} <span aria-hidden="true">{ru.common.starSign}</span>
              <VisuallyHidden>{ru.common.stars[pluralForm(REPORT_PRICE)]}</VisuallyHidden>
            </span>
          </span>
        </Button>
        <p id={noteId} className={styles.note}>
          {copy.teaserSoon}
        </p>
      </div>
    </Card>
  );
}
