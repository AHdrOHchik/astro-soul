import {
  Button,
  Checkbox,
  DocumentIcon,
  FieldMessage,
  ListButton,
  Notice,
  Screen,
  ScreenHeading,
  type ScreenProps,
} from '@astro-soul/ui';
import { useId } from 'react';
import { ru } from '../i18n/ru';
import styles from './ConsentScreen.module.css';

const copy = ru.consent;

/** A document the consent text refers to. */
export type LegalDocument = keyof typeof copy.documents;
const DOCUMENTS: readonly LegalDocument[] = ['privacy', 'terms'];

export interface ConsentScreenProps {
  /** Whether the box is ticked. The caller starts with `false`: nobody consents by default. */
  accepted: boolean;
  /** The server's text, when it rejected the consent sent with the chart request. */
  serverError?: string;
  /**
   * The texts on this screen are newer than the ones the user agreed to a moment ago:
   * the server refused those, and the app restarted to get these. Says so at the top of the screen.
   */
  renewed?: boolean;
  back?: ScreenProps['back'];
  onChange: (accepted: boolean) => void;
  onOpenDocument: (document: LegalDocument) => void;
  onNext: () => void;
  /** «Not now»: the user leaves without agreeing. Nothing is collected. */
  onDecline: () => void;
}

/**
 * Consent to the processing of personal data, asked before any birth data is
 * typed. The box and the buttons are pinned to the bottom edge: on a small
 * screen the text scrolls and the choice stays in view.
 */
export function ConsentScreen({
  accepted,
  serverError,
  renewed = false,
  back,
  onChange,
  onOpenDocument,
  onNext,
  onDecline,
}: ConsentScreenProps) {
  const titleId = useId();
  const messageId = useId();
  const renewedId = useId();
  const rejected = serverError !== undefined;

  return (
    <Screen
      labelledBy={titleId}
      back={back}
      footer={
        <>
          {/* Brought back here by the server's verdict, the user lands on the box it is about. */}
          <Checkbox
            checked={accepted}
            invalid={rejected}
            describedBy={rejected ? messageId : undefined}
            autoFocus={rejected}
            onChange={onChange}
          >
            {copy.checkbox}
          </Checkbox>
          {rejected && <FieldMessage id={messageId} error={serverError} />}
          <div className={styles.actions}>
            <Button disabled={!accepted} onClick={onNext}>
              {copy.submit}
            </Button>
            <Button variant="ghost" onClick={onDecline}>
              {copy.decline}
            </Button>
          </div>
        </>
      }
    >
      <div className={styles.content}>
        {/* First on the screen: on a small phone anything under the heading is below the fold. */}
        {renewed && (
          <Notice id={renewedId} tone="warning">
            {ru.termsUpdate.renewed}
          </Notice>
        )}
        <ScreenHeading
          id={titleId}
          title={copy.title}
          text={copy.lead}
          focusOnMount={!rejected}
          describedBy={renewed ? renewedId : undefined}
        />
        <ul className={styles.points}>
          {copy.points.map((point) => (
            <li key={point} className={styles.point}>
              {point}
            </li>
          ))}
        </ul>
        <ul className={styles.documents}>
          {DOCUMENTS.map((name) => (
            <li key={name}>
              <ListButton
                icon={<DocumentIcon />}
                title={copy.documents[name]}
                onClick={() => {
                  onOpenDocument(name);
                }}
              />
            </li>
          ))}
        </ul>
      </div>
    </Screen>
  );
}
