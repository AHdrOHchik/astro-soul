import { useEffect, useRef, useState } from 'react';
import styles from './ScreenHeading.module.css';

export interface ScreenHeadingProps {
  /** Referenced by `Screen labelledBy`. */
  id: string;
  title: string;
  text?: string;
  /**
   * Moves focus to the title when the screen opens, so a screen reader announces
   * the new screen. Leave off when the screen focuses a field instead.
   */
  focusOnMount?: boolean;
  /**
   * id of a text that says why the screen opened, e.g. a notice. A screen reader
   * reads it right after the title when the title takes focus.
   */
  describedBy?: string;
}

/** The single `h1` of a screen with an optional lead paragraph. */
export function ScreenHeading({ id, title, text, focusOnMount, describedBy }: ScreenHeadingProps) {
  const heading = useRef<HTMLHeadingElement>(null);
  // Decided once, when the screen opens: a later change of the prop must not steal focus from a control.
  const [focusAtStart] = useState(focusOnMount);
  useEffect(() => {
    // Without scrolling: a screen that opens where the user left it stays there.
    if (focusAtStart) heading.current?.focus({ preventScroll: true });
  }, [focusAtStart]);

  return (
    <header className={styles.heading}>
      <h1 ref={heading} id={id} className={styles.title} tabIndex={-1} aria-describedby={describedBy}>
        {title}
      </h1>
      {text && <p className={styles.text}>{text}</p>}
    </header>
  );
}
