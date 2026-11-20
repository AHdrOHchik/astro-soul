import { Button, Card, Skeleton, SkeletonGroup } from '@astro-soul/ui';
import { useEffect, useId, useState } from 'react';
import type { Api, CompatibilityList } from '../../api';
import { formatDayMonth } from '../../i18n/format';
import { ru } from '../../i18n/ru';
import styles from './CompatibilityHistory.module.css';

const copy = ru.compatibility;
type State = { status: 'loading' } | { status: 'error' } | { status: 'ready'; items: CompatibilityList['items'] };

/** Persistent access to server-owned compatibility results from the cabinet. */
export function CompatibilityHistory({ api, onOpen }: { api: Pick<Api, 'getCompatibilities'>; onOpen: (id: string) => void }) {
  const titleId = useId();
  const [state, setState] = useState<State>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    void api.getCompatibilities(controller.signal).then(({ items }) => {
      if (!controller.signal.aborted) setState({ status: 'ready', items });
    }).catch(() => {
      if (!controller.signal.aborted) setState({ status: 'error' });
    });
    return () => { controller.abort(); };
  }, [api, attempt]);

  return (
    <Card labelledBy={titleId} className={styles.history}>
      <h2 id={titleId} className={styles.title}>{copy.listTitle}</h2>
      {state.status === 'loading' && <SkeletonGroup label={copy.loadingQuota}><Skeleton variant="line" /></SkeletonGroup>}
      {state.status === 'error' && (
        <div role="alert" className={styles.message}>
          <p>{copy.listRetry}</p>
          <Button variant="secondary" onClick={() => { setState({ status: 'loading' }); setAttempt((value) => value + 1); }}>{ru.common.retry}</Button>
        </div>
      )}
      {state.status === 'ready' && state.items.length === 0 && <p className={styles.note}>{copy.listEmpty}</p>}
      {state.status === 'ready' && state.items.length > 0 && (
        <ul className={styles.list}>
          {state.items.map((item) => (
            <li key={item.id} className={styles.item}>
              <div>
                <p className={styles.itemTitle}>{item.titles_only[0] ?? (item.relationship ? copy.relationships[item.relationship] : copy.title)}</p>
                <p className={styles.note}>{copy.status[item.status]} · {formatDayMonth(item.created_at.slice(0, 10))}</p>
                {item.titles_only.length > 1 && <p className={styles.note}>{item.titles_only.slice(1).join(' · ')}</p>}
              </div>
              <Button variant="secondary" onClick={() => { onOpen(item.id); }}>{item.status === 'ready' ? copy.goTo : copy.retryAgain}</Button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
