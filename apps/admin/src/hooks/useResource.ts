/*
 * Загрузка блока данных одним хуком — чтобы состояния «недоступно» и «ошибка»
 * были одинаковыми во всех экранах, а не писались по месту.
 *
 * Правила, за которые отвечает хук:
 *   • запрос не уходит, если `enabled === false` (нет сессии — не дёргаем API);
 *   • маршрута нет в контракте — `unavailable` без обращения к серверу;
 *   • размонтирование снимает запрос (`AbortController`), чтобы `setState` не
 *     прилетел в мёртвый компонент;
 *   • `reload()` — единственная кнопка «Обновить»: панель оперирует живыми
 *     деньгами, и устаревший снимок опаснее пустого экрана.
 *
 * Два решения, которые стоит знать, читая хук:
 *
 *   1. `load` обязан быть мемоизирован (`useCallback`) — он в зависимостях
 *      эффекта. Inline-стрелка означала бы новый запрос на каждый рендер.
 *   2. Состояние выводится из снимка, а не пишется в начале эффекта. Синхронный
 *      `setState(loading)` в эффекте — это второй проход рендера на каждый
 *      запрос; здесь «загрузка» — это «снимка для этого `nonce` ещё нет», и
 *      лишнего прохода нет.
 */

import { useCallback, useEffect, useState } from 'react';
import { toApiError } from '../api/errors';
import { failed, loading, ok, unavailable, type Resource } from '../api/state';
import { routeLabel, route as lookupRoute, type AdminRoute } from '../api/routes';

export interface UseResourceOptions {
  /** Ключ маршрута из реестра: по нему решается, есть ли он в контракте. */
  readonly routeKey?: string;
  readonly enabled?: boolean;
}

export interface UseResourceResult<T> {
  readonly state: Resource<T>;
  readonly reload: () => void;
  readonly route: AdminRoute | null;
}

export type Loader<T> = (signal: AbortSignal) => Promise<{ data: T; demo?: boolean; requestId?: string | null }>;

interface Snapshot<T> {
  readonly nonce: number;
  readonly state: Resource<T>;
}

export function useResource<T>(load: Loader<T>, options: UseResourceOptions = {}): UseResourceResult<T> {
  const { routeKey, enabled = true } = options;
  const [nonce, setNonce] = useState(0);
  const [snapshot, setSnapshot] = useState<Snapshot<T> | null>(null);

  const item = routeKey === undefined ? null : lookupRoute(routeKey);
  const callable = item === null || item.inContract;

  useEffect(() => {
    if (!enabled || !callable) return;

    const controller = new AbortController();
    load(controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return;
        setSnapshot({ nonce, state: ok(result.data, result.demo ?? false, result.requestId ?? null) });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) return;
        setSnapshot({
          nonce,
          state: failed<T>(toApiError(error, item === null ? 'запрос' : routeLabel(item))),
        });
      });

    return () => { controller.abort(); };
  }, [callable, enabled, item, load, nonce]);

  const reload = useCallback(() => { setNonce((value) => value + 1); }, []);

  const state: Resource<T> =
    item !== null && !callable
      ? unavailable<T>(item.key)
      : snapshot !== null && snapshot.nonce === nonce
        ? snapshot.state
        : loading<T>();

  return { state, reload, route: item };
}
