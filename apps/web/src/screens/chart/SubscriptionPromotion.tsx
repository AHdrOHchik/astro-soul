import { Button, Skeleton, SkeletonGroup } from '@astro-soul/ui';
import { useEffect, useState } from 'react';
import type { Api, PlanOffer } from '../../api';
import styles from './SubscriptionPromotion.module.css';
import { copy30 } from '../../i18n/round30';

export function SubscriptionPromotion({ api, onOpen }: { api: Pick<Api, 'getPlans'>; onOpen: () => void }) {
  const [offer, setOffer] = useState<PlanOffer | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const controller = new AbortController();
    api.getPlans(controller.signal).then((plans) => {
      if (!controller.signal.aborted) setOffer(plans.find((plan) => plan.kind === 'subscription') ?? null);
    }).catch(() => { if (!controller.signal.aborted) setOffer(null); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => { controller.abort(); };
  }, [api]);
  if (loading) return <SkeletonGroup label={copy30.map.loading}><Skeleton/><Skeleton/></SkeletonGroup>;
  if (offer === null) return null;
  return <section className={styles.card}>
    <h2>{copy30.map.title}</h2>
    <p>{copy30.map.description}</p>
    {offer.includes.filter((item) => !copy30.unapprovedSubscriptionClaim.test(item)).length > 0 && <ul>{offer.includes.filter((item) => !copy30.unapprovedSubscriptionClaim.test(item)).map((item, index) => <li key={`${index}-${item}`}>{item}</li>)}</ul>}
    <p className={styles.price}>{copy30.map.price.replace('{stars}', String(offer.stars))}</p>
    <Button variant="secondary" onClick={onOpen}>{copy30.map.open}</Button>
  </section>;
}
