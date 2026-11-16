import { Button, Card, Skeleton, SkeletonGroup } from '@astro-soul/ui';
import { useEffect, useId, useState } from 'react';
import type { Api, CompatibilityQuota, PlanOffer } from '../../api';
import { formatDayMonth } from '../../i18n/format';
import { ru } from '../../i18n/ru';
import styles from './CompatibilityEntry.module.css';

const copy = ru.compatibility;
const COMPAT_PLAN = 'compat_249';

type EntryState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; quota: CompatibilityQuota; offer: PlanOffer | null; priceUnavailable: boolean };

export interface CompatibilityEntryProps {
  api: Pick<Api, 'getCompatibilities' | 'getPlans'>;
  chartId: string | null;
  onOpenForm: (chartId: string) => void;
  onBuy: (chartId: string) => void;
  /** The final report uses a lower-friction heading; settings keeps the product title. */
  reportEntry?: boolean;
  forcePurchase?: boolean;
}

/** Reads the server's current quota and, only when there is none, the live catalogue price. */
export function CompatibilityEntry({ api, chartId, onOpenForm, onBuy, reportEntry = false, forcePurchase = false }: CompatibilityEntryProps) {
  const headingId = useId();
  const [reload, setReload] = useState(0);
  const [entry, setEntry] = useState<EntryState>({ status: 'loading' });

  useEffect(() => {
    const controller = new AbortController();
    void api.getCompatibilities(controller.signal).then(async ({ quota }) => {
      if (controller.signal.aborted) return;
      if (quota.kind !== 'none' && !forcePurchase) {
        setEntry({ status: 'ready', quota, offer: null, priceUnavailable: false });
        return;
      }
      try {
        const plans = await api.getPlans(controller.signal);
        if (wasAborted(controller.signal)) return;
        const offer = plans.find((plan) => plan.plan_code === COMPAT_PLAN && !plan.test) ?? null;
        setEntry({ status: 'ready', quota, offer, priceUnavailable: offer === null });
      } catch {
        if (!wasAborted(controller.signal)) setEntry({ status: 'ready', quota, offer: null, priceUnavailable: true });
      }
    }).catch(() => {
      if (!wasAborted(controller.signal)) setEntry({ status: 'error' });
    });
    return () => { controller.abort(); };
  }, [api, forcePurchase, reload]);

  const title = reportEntry ? copy.entryTitle : copy.title;
  let status: string | null = null;
  let action: { label: string; disabled: boolean; onClick: () => void } | null = null;
  if (entry.status === 'ready') {
    const { quota, offer } = entry;
    if (forcePurchase) {
      status = offer ? copy.quotaNone(offer.stars) : copy.noPrice;
      action = offer === null ? null : { label: copy.buy(offer.stars), disabled: chartId === null, onClick: () => { if (chartId !== null) onBuy(chartId); } };
    } else if (quota.kind === 'purchase') {
      status = copy.quotaPaid;
      action = { label: copy.entryTitle, disabled: chartId === null, onClick: () => { if (chartId !== null) onOpenForm(chartId); } };
    } else if (quota.kind === 'subscription' && quota.left > 0) {
      const reset = quota.resets_at ? formatDayMonth(quota.resets_at.slice(0, 10)) : undefined;
      status = copy.quotaSubscription(quota.left, reset);
      action = { label: copy.entryTitle, disabled: chartId === null, onClick: () => { if (chartId !== null) onOpenForm(chartId); } };
    } else if (quota.kind === 'subscription') {
      const reset = quota.resets_at ? formatDayMonth(quota.resets_at.slice(0, 10)) : null;
      status = reset ? copy.quotaNext(reset) : copy.quotaNextUnknown;
      action = { label: copy.entryTitle, disabled: true, onClick: () => undefined };
    } else if (offer !== null) {
      status = copy.quotaNone(offer.stars);
      action = { label: copy.buy(offer.stars), disabled: chartId === null, onClick: () => { if (chartId !== null) onBuy(chartId); } };
    } else {
      status = copy.noPrice;
    }
  }

  return (
    <Card labelledBy={headingId} className={styles.entry}>
      <h2 id={headingId} className={styles.title}>{title}</h2>
      {entry.status === 'loading' && <SkeletonGroup label={copy.loadingQuota}><Skeleton variant="line" /></SkeletonGroup>}
      {entry.status === 'error' && (
        <div role="alert" className={styles.message}>
          <p>{copy.quotaError}</p>
          <Button variant="secondary" onClick={() => { setEntry({ status: 'loading' }); setReload((value) => value + 1); }}>{ru.common.retry}</Button>
        </div>
      )}
      {entry.status === 'ready' && (
        <>
          <p className={styles.status}>{status}</p>
          <p className={styles.note}>{copy.purchaseDisclosure}</p>
          {chartId === null && <p className={styles.note}>{copy.emptyChart}</p>}
          {action && <Button disabled={action.disabled} onClick={action.onClick}>{action.label}</Button>}
        </>
      )}
    </Card>
  );
}

function wasAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}
