import { Button, GearIcon, Screen, ScreenHeading } from '@astro-soul/ui';
import { useCallback, useId } from 'react';
import type { Api } from '../../api';
import { Stars } from '../../components/Stars';
import { useRequest } from '../../hooks/useRequest';
import { REPORT_PLAN } from '../../lib/plans';
import { ru } from '../../i18n/ru';
import { Emblem } from './Emblem';
import styles from './WelcomeScreen.module.css';

const copy = ru.welcome;

export interface WelcomeScreenProps {
  api: Pick<Api, 'getPlans'>;
  onStart: () => void;
  /** Opens the user agreement, where the full disclaimer is. */
  onOpenTerms: () => void;
  /** Opens the settings: the way to delete one's data is there for a user without a chart too. */
  onOpenSettings: () => void;
}

/**
 * Screen 1. The 18+ / entertainment disclaimer sits in the pinned footer, next
 * to the main button: it is on screen without scrolling at any viewport height.
 * Under the button, in small print, is the way to the full text.
 */
export function WelcomeScreen({ api, onStart, onOpenTerms, onOpenSettings }: WelcomeScreenProps) {
  const titleId = useId();
  const load = useCallback((signal: AbortSignal) => api.getPlans(signal), [api]);
  const catalogue = useRequest(load);
  const report = catalogue.status === 'ready'
    ? catalogue.data.find((plan) => !plan.test && plan.kind === 'one_off' && plan.plan_code === REPORT_PLAN)
    : undefined;
  return (
    <Screen
      labelledBy={titleId}
      action={{ label: ru.common.settings, icon: <GearIcon />, onClick: onOpenSettings }}
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
          <ScreenHeading id={titleId} title={copy.title} text={copy.lead} focusOnMount />
          <p className={styles.offer}>{copy.freeChart}{report && <> {copy.fullReport} <Stars count={report.stars} /></>}</p>
          <Emblem />
        </div>
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
