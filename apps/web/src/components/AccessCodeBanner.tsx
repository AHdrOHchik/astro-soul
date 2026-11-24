import { Button, Notice } from '@astro-soul/ui';
import { useState } from 'react';
import type { Entitlements } from '../api';
import { ru } from '../i18n/ru';
import { partnerGrant } from '../lib/accessCode';
import { grantWords } from '../screens/access-code/words';
import styles from './AccessCodeBanner.module.css';

export interface AccessCodeBannerProps {
  /** This start came from a `pt_<code>` link: the server has already activated the code. */
  startedWithCode: boolean;
  /** What the server says is open now; the payload itself is never read for anything but its prefix. */
  entitlements: Entitlements;
}

/**
 * The one-time banner for a start from a `pt_<code>` link. The code was activated by the
 * server before the app was drawn, so there is nothing to ask for again: this says what
 * opened, in words, with the honest «starts with the chart» when the term has not begun.
 *
 * Shown once per start: a reload is a new start, and the banner says nothing a second
 * time within one.
 */
export function AccessCodeBanner({ startedWithCode, entitlements }: AccessCodeBannerProps) {
  const [dismissed, setDismissed] = useState(false);
  if (!startedWithCode || dismissed) return null;
  const grant = partnerGrant(entitlements);
  // A link whose code the server did not take (an expired one, say) left nothing to announce.
  if (grant === null) return null;
  return (
    <div className={styles.banner} role="status" aria-label={ru.accessCode.banner.label}>
      <Notice>{grantWords(grant, 'banner')}</Notice>
      <Button
        variant="secondary"
        onClick={() => {
          setDismissed(true);
        }}
      >
        {ru.accessCode.banner.dismiss}
      </Button>
    </div>
  );
}
