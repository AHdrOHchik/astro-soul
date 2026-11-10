import type { ReactNode } from 'react';
import styles from './ListButton.module.css';

export interface ListButtonProps {
  title: string;
  description?: string;
  /** Decorative icon before the text. */
  icon?: ReactNode;
  onClick: () => void;
}

/** A row that acts at once when tapped, e.g. a search result. At least --size-field tall. */
export function ListButton({ title, description, icon, onClick }: ListButtonProps) {
  return (
    <button type="button" className={styles.row} onClick={onClick}>
      {icon && <span className={styles.icon}>{icon}</span>}
      <span className={styles.text}>
        <span className={styles.title}>{title}</span>
        {description && <span className={styles.description}>{description}</span>}
      </span>
    </button>
  );
}
