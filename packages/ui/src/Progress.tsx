import styles from './Progress.module.css';

export interface ProgressProps {
  /** 0…100. Shown as it is given: the bar has no motion of its own. */
  value: number;
  /** What is progressing, for a screen reader. */
  label: string;
}

/** A bar for progress that somebody else measures. The native element: it is read out as «N percent». */
export function Progress({ value, label }: ProgressProps) {
  return <progress className={styles.progress} max={100} value={value} aria-label={label} />;
}
