import { useEffect, useRef } from 'react';
import { cx } from './cx';
import styles from './FieldMessage.module.css';
import { AlertIcon } from './icons';

export interface FieldMessageProps {
  /** Point the field's `aria-describedby` here. */
  id: string;
  /** Shown instead of the hint and announced at once. */
  error?: string | null;
  hint?: string;
  /** The hint reports progress (a search, for example): its changes are announced politely. */
  live?: boolean;
}

/**
 * Hint or error under a field. Both share one slot of a fixed minimum height,
 * so an error appearing does not push the rest of the form down.
 */
export function FieldMessage({ id, error, hint, live }: FieldMessageProps) {
  const message = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    // On a small screen or with the keyboard open the slot can be below the fold: an error must not go unseen.
    if (error) message.current?.scrollIntoView({ block: 'nearest' });
  }, [error]);

  return (
    <div className={styles.slot}>
      {/* The live region stays mounted: text that appears inside it is what gets announced. */}
      <p
        ref={message}
        id={id}
        className={cx(styles.message, error ? styles.error : styles.hint)}
        role={error ? 'alert' : live ? 'status' : undefined}
      >
        {error && <AlertIcon />}
        <span>{error ?? hint}</span>
      </p>
    </div>
  );
}
