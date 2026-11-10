import { cx } from './cx';
import styles from './Steps.module.css';

export interface StepsProps {
  /** 1-based index of the current step. */
  current: number;
  total: number;
  /** Full text, e.g. "Step 1 of 3" — the bars are decorative. */
  label: string;
}

export function Steps({ current, total, label }: StepsProps) {
  return (
    <div className={styles.steps}>
      <p className={styles.label}>{label}</p>
      <div className={styles.bars} aria-hidden="true">
        {Array.from({ length: total }, (_, index) => (
          <span key={index} className={cx(styles.bar, index < current && styles.done)} />
        ))}
      </div>
    </div>
  );
}
