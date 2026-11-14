import { ForwardIcon } from '@astro-soul/ui';
import styles from './SubscriptionHint.module.css';

export interface SubscriptionHintProps {
  /** What a subscription adds at this very place, as a statement. */
  text: string;
  /** On to the paywall. */
  onOpen: () => void;
}

/**
 * The quiet way to the subscriptions: one line that says what a subscription adds here,
 * and opens the paywall when tapped. A note, never a call to pay: it stands under the
 * content the user came for and does not compete with it.
 *
 * Rendered only where a subscription can be offered at all: the caller leaves it out for a
 * subscriber, and for a build that sells no subscriptions.
 */
export function SubscriptionHint({ text, onOpen }: SubscriptionHintProps) {
  return (
    <button type="button" className={styles.hint} onClick={onOpen}>
      <span className={styles.text}>{text}</span>
      <span className={styles.arrow}>
        <ForwardIcon />
      </span>
    </button>
  );
}
