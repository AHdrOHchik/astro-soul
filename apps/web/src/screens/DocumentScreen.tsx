import { Screen, ScreenHeading, type ScreenProps } from '@astro-soul/ui';
import { Fragment, useId } from 'react';
import { ru } from '../i18n/ru';
import type { LegalDocument } from './ConsentScreen';
import styles from './DocumentScreen.module.css';

const copy = ru.documents;

export interface DocumentScreenProps {
  name: LegalDocument;
  back?: ScreenProps['back'];
}

/**
 * Where a document link of the consent screen leads: a screen of the app itself,
 * so the user never leaves it and comes back to the consent with one step.
 */
export function DocumentScreen({ name, back }: DocumentScreenProps) {
  const titleId = useId();
  return (
    <Screen labelledBy={titleId} back={back}>
      <div className={styles.content}>
        <ScreenHeading id={titleId} title={ru.consent.documents[name]} focusOnMount />
        {name === 'privacy' ? <Privacy /> : <p>{copy.terms.disclaimer}</p>}
      </div>
    </Screen>
  );
}

/**
 * The table of `legal.md` turned on its side: one block per row, the column names
 * repeated beside each value. Three columns side by side do not fit a phone: at
 * 320 px the longest words of the table are wider than a third of the screen.
 */
function Privacy() {
  const captionId = useId();
  const { caption, columns, rows, notCollected } = copy.privacy;
  return (
    <>
      <section className={styles.section} aria-labelledby={captionId}>
        <h2 id={captionId} className={styles.caption}>
          {caption}
        </h2>
        <ul>
          {rows.map((row) => (
            <li key={row[0]} className={styles.record}>
              <dl className={styles.fields}>
                {columns.map((column, index) => (
                  <Fragment key={column}>
                    <dt className={styles.name}>{column}</dt>
                    <dd className={index === 0 ? styles.subject : styles.value}>{row[index]}</dd>
                  </Fragment>
                ))}
              </dl>
            </li>
          ))}
        </ul>
      </section>
      <p>{notCollected}</p>
    </>
  );
}
