import { Button, Card, Skeleton, SkeletonGroup } from '@astro-soul/ui';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { Api, CompatibilityList } from '../../api';
import { HISTORY_PAGE_SIZE, type HistoryPageCache } from '../../lib/history-pagination';
import { formatDayMonth } from '../../i18n/format';
import { ru } from '../../i18n/ru';
import styles from './CompatibilityHistory.module.css';

const copy = ru.compatibility;
type Item = CompatibilityList['items'][number];
type State = { status: 'loading' } | { status: 'error' } | { status: 'ready'; items: Item[]; total: number };
export type CompatibilityHistoryCache = HistoryPageCache<Item>;

/** Persistent access to server-owned compatibility results from the cabinet. */
export function CompatibilityHistory({
  api,
  onOpen,
  chartId,
  onBuy,
  cache = null,
  onCacheChange,
  scrollContainer,
}: {
  api: Pick<Api, 'getCompatibilities' | 'getPlans'>;
  onOpen: (id: string) => void;
  chartId: string | null;
  onBuy?: (chartId: string) => void;
  cache?: CompatibilityHistoryCache | null;
  onCacheChange?: (cache: CompatibilityHistoryCache) => void;
  scrollContainer: { current: HTMLElement | null };
}) {
  const titleId = useId();
  const initial = cache;
  const [state, setState] = useState<State>(() => initial === null
    ? { status: 'loading' }
    : { status: 'ready', items: initial.items, total: initial.total });
  const itemsRef = useRef(initial?.items ?? []);
  const [attempt, setAttempt] = useState(0);
  const [stars, setStars] = useState<number | null>(null);
  const [plansLoading, setPlansLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState(false);
  const [hasMore, setHasMore] = useState(() => initial?.hasMore ?? false);
  const nextOffset = useRef(initial?.nextOffset ?? 0);
  const moreInFlight = useRef(false);
  const visibleItems = state.status === 'ready' ? state.items.filter((item) => item.status !== 'failed') : [];
  const total = state.status === 'ready' ? state.total : 0;

  const loadPage = useCallback(async (offset: number, signal?: AbortSignal) => {
    const result = await api.getCompatibilities(HISTORY_PAGE_SIZE, offset, signal);
    const items = result.items.filter((item) => item.status !== 'failed');
    const totalCount = result.total ?? items.length;
    const next = offset + result.items.length;
    nextOffset.current = next;
    const existing = itemsRef.current;
    const merged = offset === 0 ? items : [...existing, ...items.filter((item) => !existing.some((old) => old.id === item.id))];
    itemsRef.current = merged;
    setState({ status: 'ready', items: merged, total: totalCount });
    const hasNext = result.items.length > 0 && next < totalCount;
    setHasMore(hasNext);
    onCacheChange?.({ items: merged, total: totalCount, nextOffset: next, hasMore: hasNext });
    setLoadMoreError(false);
    if (items.length === 0 && totalCount === 0) {
      setPlansLoading(true);
      void api.getPlans(signal).then((plans) => {
        if (signal?.aborted) return;
        const offer = plans.find((plan) => plan.plan_code === 'compat_249' && !plan.test);
        setStars(offer?.stars ?? null);
      }).catch(() => undefined).finally(() => {
        if (!signal?.aborted) setPlansLoading(false);
      });
    }
    return items;
  }, [api, onCacheChange]);

  useEffect(() => {
    if (cache !== null) return undefined;
    const controller = new AbortController();
    void Promise.resolve().then(() => loadPage(0, controller.signal)).catch(() => {
      if (!controller.signal.aborted) setState({ status: 'error' });
    });
    return () => { controller.abort(); };
  }, [api, attempt, cache, loadPage]);

  const loadMore = useCallback(async () => {
    if (!hasMore || loadingMore || moreInFlight.current) return;
    moreInFlight.current = true;
    setLoadingMore(true);
    setLoadMoreError(false);
    const controller = new AbortController();
    try {
      await loadPage(nextOffset.current, controller.signal);
    } catch {
      if (!controller.signal.aborted) setLoadMoreError(true);
    } finally {
      moreInFlight.current = false;
      setLoadingMore(false);
    }
  }, [hasMore, loadPage, loadingMore]);

  useEffect(() => {
    const element = scrollContainer.current;
    if (element === null) return undefined;
    const onScroll = () => {
      if (element.scrollHeight - element.scrollTop - element.clientHeight < 120) void loadMore();
    };
    element.addEventListener('scroll', onScroll, { passive: true });
    return () => { element.removeEventListener('scroll', onScroll); };
  }, [loadMore, scrollContainer]);

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
      {state.status === 'ready' && <>
        <p className={styles.note}>{copy.listCount(total)}</p>
        {visibleItems.length === 0 && total === 0 && <>
          <p className={styles.note}>{copy.listEmpty}</p>
          {plansLoading ? <p className={styles.note}>{copy.listPriceLoading}</p> : stars === null ? <p className={styles.note}>{copy.noPrice}</p> : <Button disabled={chartId === null || onBuy === undefined} onClick={() => { if (chartId !== null) onBuy?.(chartId); }}>{copy.buy(stars)}</Button>}
        </>}
        {visibleItems.length > 0 && <ul className={styles.list}>
          {visibleItems.map((item) => (
            <li key={item.id} className={styles.item}>
              <div>
                <p className={styles.itemTitle}>{item.titles_only[0] ?? (item.relationship ? copy.relationships[item.relationship] : copy.title)}</p>
                <p className={styles.note}>{copy.status[item.status]} · {formatDayMonth(item.created_at.slice(0, 10))}</p>
                {item.titles_only.length > 1 && <p className={styles.note}>{item.titles_only.slice(1).join(' · ')}</p>}
              </div>
              <Button variant="secondary" onClick={() => { onOpen(item.id); }}>{copy.goTo}</Button>
            </li>
          ))}
        </ul>}
        {loadingMore && <p role="status" className={styles.note}>{copy.listLoadMore}</p>}
        {loadMoreError && <div role="alert"><p>{copy.listLoadMoreError}</p><Button variant="secondary" onClick={() => { void loadMore(); }}>{ru.common.retry}</Button></div>}
        {hasMore && !loadingMore && !loadMoreError && <Button variant="secondary" onClick={() => { void loadMore(); }}>{copy.listLoadMore}</Button>}
      </>}
    </Card>
  );
}
