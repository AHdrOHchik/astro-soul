import { Button, Notice } from '@astro-soul/ui';
import { useId, useRef, useState } from 'react';
import { failureCodeOf, isApiError, type Api, type Me } from '../../api';
import type { Track } from '../../analytics';
import { SupportButton } from '../../components/SupportButton';
import { formatDay } from '../../i18n/format';
import { newIdempotencyKey } from '../../lib/idempotency';
import { ru } from '../../i18n/ru';
import type { Telegram } from '../../telegram';
import styles from './SubscriptionInfo.module.css';

const copy = ru.settings.subscription;

type CancelFailure = { message: string; retry: boolean; refresh: boolean; support: boolean };

export interface SubscriptionInfoProps {
  subscription: Me['subscription'];
  api: Pick<Api, 'cancelSubscription'>;
  telegram: Pick<Telegram, 'openLink'>;
  supportLink: string;
  track: Track;
  refreshMe: (signal?: AbortSignal) => Promise<Me>;
  onSubscribe?: () => void;
}

export function SubscriptionInfo({ subscription, api, telegram, supportLink, track, refreshMe, onSubscribe }: SubscriptionInfoProps) {
  const titleId = useId();
  const [serverSubscription, setServerSubscription] = useState(subscription);
  const keyRef = useRef<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<CancelFailure | null>(null);
  const [notice, setNotice] = useState('');
  const until = serverSubscription.expires_at === null ? null : formatDay(serverSubscription.expires_at);

  const refreshSubscription = async () => {
    setSending(true);
    try {
      const fresh = await refreshMe();
      setServerSubscription(fresh.subscription);
      setFailure(null);
      return true;
    } catch {
      setFailure({ message: copy.refreshStatusFailed, retry: false, refresh: true, support: false });
      return false;
    } finally {
      setSending(false);
    }
  };

  const finishAndRefresh = async () => {
    keyRef.current = null;
    setConfirming(false);
    await refreshSubscription();
  };

  const cancel = async () => {
    if (keyRef.current === null) keyRef.current = newIdempotencyKey();
    const key = keyRef.current;
    setSending(true);
    setFailure(null);
    setNotice('');
    try {
      await api.cancelSubscription(key);
      // The POST is validated by the API client; rendered subscription state still comes exclusively from GET /me.
      await finishAndRefresh();
    } catch (error) {
      setSending(false);
      setConfirming(false);
      if (isApiError(error) && error.status === 409) {
        const reason = error.details?.reason;
        if (reason === 'already_cancelled') setNotice(copy.alreadyCancelled);
        else if (reason === 'no_active_subscription') setNotice(copy.noActiveSubscription);
        keyRef.current = null;
            setConfirming(false);
        await refreshSubscription();
        return;
      }
      if (isApiError(error) && error.status === 502) {
        const reason = error.details?.reason;
        const supportOnly = reason === 'no_charge_id' || reason === 'gave_up';
        const message = reason === 'no_charge_id'
          ? until === null ? copy.noChargeIdNoDate : copy.noChargeId(until)
          : supportOnly ? until === null ? copy.gaveUpNoDate : copy.gaveUp(until)
            : until === null ? copy.cancelFailedNoDate : copy.cancelFailed(until);
        setFailure({ message, retry: !supportOnly, refresh: false, support: supportOnly });
        track('error_shown', { screen: 'settings', code: `subscription_cancel_${typeof reason === 'string' ? reason : 'upstream'}` });
        return;
      }
      if (isApiError(error) && error.status === 422) {
        // A valid UUID v4 was generated in this component; a 422 therefore indicates a client/contract defect.
        track('error_shown', { screen: 'settings', code: 'subscription_cancel_invalid_key' });
        setFailure({ message: copy.cancelInvalidKey, retry: false, refresh: true, support: true });
        return;
      }
      setFailure({ message: copy.cancelGenericError, retry: true, refresh: false, support: false });
      track('error_shown', { screen: 'settings', code: failureCodeOf(error) });
    }
  };

  if (serverSubscription.plan === 'none') {
    return (
      <>
        {notice && <p role="status">{notice}</p>}
        <p>{copy.none}</p>
        {onSubscribe && <Button variant="secondary" onClick={onSubscribe}>{copy.offer}</Button>}
      </>
    );
  }

  if (!serverSubscription.is_active) {
    return (
      <>
        {notice && <p role="status">{notice}</p>}
        <p>{until === null ? copy.ended : copy.endedAt(until)}</p>
        {onSubscribe && <Button variant="secondary" onClick={onSubscribe}>{copy.subscribeAgain}</Button>}
      </>
    );
  }

  const activeLine = until === null ? copy.active : copy.activeUntil(until);
  if (!serverSubscription.auto_renew) {
    const cancelled = typeof serverSubscription.cancelled_at === 'string' ? formatDay(serverSubscription.cancelled_at) : null;
    return (
      <>
        <p>{copy.names[serverSubscription.plan]}</p>
        <p className={styles.muted}>
          {cancelled !== null ? copy.cancelledAt(cancelled, until) : until === null ? copy.noRenewalNoDate : copy.noRenewalUntil(until)}
        </p>
        {until !== null && <p className={styles.muted}>{copy.offerAgainAfter(until)}</p>}
        {notice && <p role="status">{notice}</p>}
      </>
    );
  }

  return (
    <>
      <p>{copy.names[serverSubscription.plan]}</p>
      <p className={styles.muted}>{until === null ? `${activeLine} ${copy.renews}` : activeLine}</p>
      {notice && <p role="status">{notice}</p>}
      {failure && (
        <div role="alert" className={styles.failure}>
          <Notice tone="warning">{failure.message}</Notice>
          {failure.retry && <Button variant="secondary" onClick={() => { void cancel(); }}>{copy.retryCancel}</Button>}
          {failure.support && <SupportButton link={supportLink} telegram={telegram} />}
          {failure.refresh && <Button variant="secondary" onClick={() => { void refreshSubscription(); }}>{copy.refreshStatus}</Button>}
        </div>
      )}
      {failure?.support ? null : confirming ? (
        <div role="alertdialog" aria-labelledby={titleId} className={styles.confirm}>
          <h3 id={titleId}>{copy.cancelTitle}</h3>
          {until === null ? (
            <p>{copy.noPeriodDate}</p>
          ) : (
            <>
              <p>{copy.confirmCancel(until)}</p>
              <p className={styles.muted}>{copy.noRefundStars}</p>
            </>
          )}
          <div className={styles.actions}>
            <Button disabled={sending || until === null} onClick={() => { void cancel(); }}>{copy.confirmCancelAction}</Button>
            <Button variant="secondary" disabled={sending} onClick={() => { setConfirming(false); }}>{copy.keepSubscription}</Button>
          </div>
        </div>
      ) : (
        <Button variant="secondary" disabled={sending || until === null} onClick={() => { setFailure(null); setConfirming(true); }}>
          {sending ? copy.cancelling : copy.cancelAutoRenew}
        </Button>
      )}
      {sending && <p role="status" className={styles.muted}>{copy.cancelling}</p>}
    </>
  );
}
