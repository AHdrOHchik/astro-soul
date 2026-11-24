/*
 * Единственный рендерер состояний блока данных. Он здесь один специально:
 * «недоступно», «ошибка» и «пусто» на всех экранах обязаны выглядеть одинаково,
 * иначе на одном экране админ увидит таблицу с нулями вместо «маршрута нет», и
 * примет по этим нулям решение.
 */

import type { ReactNode } from 'react';
import { routeLabel } from '../api/routes';
import type { Resource } from '../api/state';
import { ru } from '../i18n/ru';
import { Banner, Notice } from './primitives';

export interface BlockProps<T> {
  readonly state: Resource<T>;
  readonly onReload?: () => void;
  /** Пусто при `ok`: сервер ответил, данных нет — это отдельная правда. */
  readonly empty?: string;
  readonly isEmpty?: (data: T) => boolean;
  readonly children: (data: T) => ReactNode;
}

export function Block<T>({ state, onReload, empty, isEmpty, children }: BlockProps<T>) {
  if (state.kind === 'loading') return <Notice>{ru.app.loading}</Notice>;

  if (state.kind === 'unavailable') {
    return (
      <Banner level="info" title={ru.states.unavailable}>
        {state.routes.length > 0 ? (
          <>
            <p>{ru.states.unavailableRoutes}</p>
            <ul className="tight mono">
              {state.routes.map((item) => (
                <li key={`${item.method}-${item.path}`}>{routeLabel(item)}</li>
              ))}
            </ul>
          </>
        ) : null}
        <p>{ru.states.unavailableNoData}</p>
      </Banner>
    );
  }

  if (state.kind === 'error') {
    const error = state.error;
    const level = error.isUnauthorized || error.isForbidden ? 'warn' : 'crit';
    const title = error.isUnauthorized ? ru.states.unauthorized : error.isForbidden ? ru.states.forbidden : `${ru.states.error}: ${error.message}`;
    return (
      <Banner level={level} title={title}>
        {/* Для 401/403 заголовком становится наша формулировка — слова
            сервера при этом не прячутся: он мог добавить, кого именно не
            пустили и почему («не в ADMIN_TG_ID» и «нет права на этот раздел»
            чинятся по-разному). */}
        {error.isUnauthorized || error.isForbidden ? <p>{error.message}</p> : null}
        <p className="muted mono">
          {error.code}
          {error.reason ? ` · ${error.reason}` : ''}
          {error.requestId ? ` · request_id ${error.requestId}` : ''}
        </p>
        {error.fieldErrors.length > 0 ? (
          <ul className="tight">
            {error.fieldErrors.map((item) => (
              <li key={`${item.field}-${item.message}`}>
                <span className="mono">{item.field}</span>: {item.message}
              </li>
            ))}
          </ul>
        ) : null}
        {onReload ? (
          <p>
            <button type="button" onClick={onReload}>
              {ru.states.retry}
            </button>
          </p>
        ) : null}
      </Banner>
    );
  }

  if (isEmpty?.(state.data) === true) return <Notice>{empty ?? ru.states.empty}</Notice>;

  return <>{children(state.data)}</>;
}
