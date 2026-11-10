import type { ReactNode } from 'react';
import { cx } from './cx';
import styles from './Skeleton.module.css';
import { VisuallyHidden } from './VisuallyHidden';

export interface SkeletonProps {
  variant?: 'line' | 'block' | 'circle';
  /** Sizing comes from the caller's stylesheet so the placeholder matches the real content. */
  className?: string;
}

export function Skeleton({ variant = 'line', className }: SkeletonProps) {
  return <span className={cx(styles.skeleton, styles[variant], className)} aria-hidden="true" />;
}

/** Wraps placeholders and announces the loading state once. */
export function SkeletonGroup({ label, className, children }: { label: string; className?: string; children: ReactNode }) {
  return (
    <div className={className} role="status" aria-busy="true">
      <VisuallyHidden>{label}</VisuallyHidden>
      {children}
    </div>
  );
}
