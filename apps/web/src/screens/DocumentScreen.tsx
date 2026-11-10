import { Screen, ScreenHeading, type ScreenProps } from '@astro-soul/ui';
import { useId } from 'react';
import { CONSENT_VERSION, ru } from '../i18n/ru';
import type { LegalDocument } from './ConsentScreen';
import styles from './DocumentScreen.module.css';

const copy = ru.documents;

export interface DocumentScreenProps {
  name: LegalDocument;
  back?: ScreenProps['back'];
}

/**
 * A legal document as a screen of the app itself: the user never leaves the app
 * and comes back with one step. The text is the short version the project has
 * (`ru.documents`), followed by its version, the one sent with the consent.
 */
export function DocumentScreen({ name, back }: DocumentScreenProps) {
  const titleId = useId();
  return (
    <Screen labelledBy={titleId} back={back}>
      <div className={styles.content}>
        <ScreenHeading id={titleId} title={ru.consent.documents[name]} focusOnMount />
        {copy[name].paragraphs.map((paragraph) => (
          <p key={paragraph}>{paragraph}</p>
        ))}
        <p className={styles.version}>{copy.version(CONSENT_VERSION)}</p>
      </div>
    </Screen>
  );
}
