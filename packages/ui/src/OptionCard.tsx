import { useId } from 'react';
import styles from './OptionCard.module.css';

export interface OptionCardProps<Value extends string> {
  /** Radio group name: options sharing it are mutually exclusive. */
  name: string;
  value: Value;
  checked: boolean;
  onSelect: (value: Value) => void;
  title: string;
  description?: string;
}

/** A radio button drawn as a large tappable card. */
export function OptionCard<Value extends string>({
  name,
  value,
  checked,
  onSelect,
  title,
  description,
}: OptionCardProps<Value>) {
  const id = useId();
  const titleId = `${id}-title`;
  const descriptionId = `${id}-description`;
  return (
    <label className={styles.option}>
      <input
        className={styles.input}
        type="radio"
        name={name}
        value={value}
        checked={checked}
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        onChange={() => {
          onSelect(value);
        }}
      />
      <span className={styles.box}>
        <span className={styles.mark} aria-hidden="true" />
        <span className={styles.text}>
          <span id={titleId} className={styles.title}>
            {title}
          </span>
          {description && (
            <span id={descriptionId} className={styles.description}>
              {description}
            </span>
          )}
        </span>
      </span>
    </label>
  );
}
