/*
 * The words for what a code opened. Both the screen and the one-time banner say it, and
 * they must not drift apart: the same right, said the same way, with the date where there
 * is one and the honest «starts with the chart» where there is not.
 */
import { formatDayMonthOf } from '../../i18n/format';
import { ru } from '../../i18n/ru';
import type { AccessGrant } from '../../lib/accessCode';

/** The shape both the confirmation and the banner have: one sentence per kind of right. */
export interface GrantWords {
  allAccess: (date: string) => string;
  pending: string;
  singleReport: string;
  singleCompat: string;
}

/** What the server opened, said to the person whose code it was. */
export function grantWords(grant: AccessGrant, where: 'success' | 'banner' = 'success'): string {
  const copy: GrantWords = where === 'banner' ? ru.accessCode.banner : ru.accessCode.success;
  switch (grant.kind) {
    case 'all_access':
      return copy.allAccess(formatDayMonthOf(grant.until));
    case 'single_report':
      return copy.singleReport;
    case 'single_compat':
      return copy.singleCompat;
    case 'pending':
      return copy.pending;
  }
}
