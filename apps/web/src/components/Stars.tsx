import { VisuallyHidden } from '@astro-soul/ui';
import { formatCount, pluralForm } from '../i18n/format';
import { ru } from '../i18n/ru';
import styles from './Stars.module.css';

/** A price in Telegram Stars: the number and the star sign for the eye, the number and the word for a screen reader. The number and the star never part. */
export function Stars({ count }: { count: number }) {
  return (
    <span className={styles.stars}>
      {formatCount(count)} <span aria-hidden="true">{ru.common.starSign}</span>
      <VisuallyHidden>{ru.common.stars[pluralForm(count)]}</VisuallyHidden>
    </span>
  );
}
