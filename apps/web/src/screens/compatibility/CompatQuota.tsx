import { useEffect, useState } from 'react';
import type { Api, CompatibilityQuota } from '../../api';
import { formatDayMonth } from '../../i18n/format';
import { ru } from '../../i18n/ru';
import styles from '../settings/SettingsScreen.module.css';

const copy = ru.compatibility;

/** The only formatter for compatibility quota wherever the app shows it. */
export function formatCompatQuota(quota: CompatibilityQuota): { value: string; reset: string | null } {
  if (quota.kind === 'subscription') {
    return {
      value: ru.settings.quotas.left(quota.left, 1),
      reset: quota.resets_at === null ? null : ru.settings.quotas.resets(formatDayMonth(quota.resets_at.slice(0, 10))),
    };
  }
  if (quota.kind === 'purchase') {
    return { value: quota.left > 0 ? copy.quotaPaid : copy.purchaseUsed, reset: null };
  }
  return { value: copy.quotaUnavailable, reset: null };
}

/** Settings reads this row only from GET /compatibility, never from GET /me. */
export function CompatQuotaRow({ api }: { api: Pick<Api, 'getCompatibilities'> }) {
  const [state, setState] = useState<{ status: 'loading' } | { status: 'error' } | { status: 'ready'; quota: CompatibilityQuota }>({ status: 'loading' });

  useEffect(() => {
    const controller = new AbortController();
    void api.getCompatibilities(controller.signal).then(({ quota }) => {
      if (!controller.signal.aborted) setState({ status: 'ready', quota });
    }).catch(() => {
      if (!controller.signal.aborted) setState({ status: 'error' });
    });
    return () => { controller.abort(); };
  }, [api]);

  const formatted = state.status === 'ready' ? formatCompatQuota(state.quota) : null;
  return (
    <li className={styles.quota}>
      <span>{copy.quotaLabel}</span>
      <span className={styles.quotaValue}>
        {state.status === 'loading' ? copy.quotaLoading : state.status === 'error' ? copy.quotaUnavailable : formatted?.value}
      </span>
      {formatted?.reset && <span className={styles.quotaNote}>{formatted.reset}</span>}
    </li>
  );
}
