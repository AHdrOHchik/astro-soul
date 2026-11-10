import { Button, Notice, Screen, ScreenHeading } from '@astro-soul/ui';
import { useId } from 'react';
import { ru } from '../../i18n/ru';
import { Emblem } from './Emblem';
import styles from './WelcomeScreen.module.css';

const copy = ru.welcome;

export interface WelcomeScreenProps {
  /** `Me.has_chart`: the user already built a chart earlier. */
  returning: boolean;
  onStart: () => void;
  /** Opens the user agreement, where the full disclaimer is. */
  onOpenTerms: () => void;
}

/**
 * Screen 1. The 18+ / entertainment disclaimer sits in the pinned footer, next
 * to the main button: it is on screen without scrolling at any viewport height.
 * Under the button, in small print, is the way to the full text.
 */
export function WelcomeScreen({ returning, onStart, onOpenTerms }: WelcomeScreenProps) {
  const titleId = useId();
  return (
    <Screen
      labelledBy={titleId}
      footer={
        <>
          <p className={styles.disclaimer}>{copy.disclaimer}</p>
          <Button onClick={onStart}>{copy.start}</Button>
          {/* The whole sentence is the control: the words drawn as a link are too small a target on their own. */}
          <button type="button" className={styles.terms} onClick={onOpenTerms}>
            {copy.terms.before}
            <span className={styles.termsLink}>{copy.terms.link}</span>
            {copy.terms.after}
          </button>
        </>
      }
    >
      <div className={styles.content}>
        <div className={styles.hero}>
          <Emblem />
          <ScreenHeading id={titleId} title={copy.title} text={copy.lead} focusOnMount />
        </div>
        {returning && <Notice>{copy.returning}</Notice>}
        <ul className={styles.points}>
          {copy.points.map((point) => (
            <li key={point.title} className={styles.point}>
              <span className={styles.pointTitle}>{point.title}</span>
              <span className={styles.pointText}>{point.text}</span>
            </li>
          ))}
        </ul>
      </div>
    </Screen>
  );
}
