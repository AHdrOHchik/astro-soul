import { Button, Notice, Screen, ScreenHeading } from '@astro-soul/ui';
import { useId } from 'react';
import { ru } from '../../i18n/ru';
import { Emblem } from './Emblem';
import styles from './WelcomeScreen.module.css';

export interface WelcomeScreenProps {
  /** `Me.has_chart`: the user already built a chart earlier. */
  returning: boolean;
  onStart: () => void;
}

/**
 * Screen 1. The 18+ / entertainment disclaimer sits in the pinned footer, next
 * to the only button: it is on screen without scrolling at any viewport height.
 */
export function WelcomeScreen({ returning, onStart }: WelcomeScreenProps) {
  const titleId = useId();
  return (
    <Screen
      labelledBy={titleId}
      footer={
        <>
          <p className={styles.disclaimer}>{ru.welcome.disclaimer}</p>
          <Button onClick={onStart}>{ru.welcome.start}</Button>
        </>
      }
    >
      <div className={styles.content}>
        <div className={styles.hero}>
          <Emblem />
          <ScreenHeading id={titleId} title={ru.welcome.title} text={ru.welcome.lead} focusOnMount />
        </div>
        {returning && <Notice>{ru.welcome.returning}</Notice>}
        <ul className={styles.points}>
          {ru.welcome.points.map((point) => (
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
