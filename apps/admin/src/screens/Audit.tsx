/*
 * Экран «Аудит» (ТЗ §4.7, маршрут пришёл в 1.6.15). Лента `at DESC`, страницы —
 * по курсору `next_cursor`, а не по номеру: журнал пополняется на каждом
 * действии, и `offset` на живой ленте теряет и дублирует строки.
 *
 * Что здесь запрещено:
 *   • «обновить запись» или «удалить» — таблица append-only на стороне БД,
 *     и интерфейс не делает вида, что умеет то, чего нет;
 *   • джойнинга за «текущим именем»: `actor_name` — снимок на момент действия,
 *     он и рисуется;
 *   • пустых ячеек: различий нет — показан «—», а не молчание;
 *   • CSV-выгрузки: в этой итерации её нет, список без ПДн тому не причина.
 *
 * Фильтры живут в URL-хеше: ссылку на конкретный срез можно переслать, и
 * кнопка «Назад» в браузере работает как отмена фильтра.
 */

import { useCallback, useMemo, useState } from 'react';
import type { AdminApi, AuditQuery } from '../api/admin';
import { toApiError } from '../api/errors';
import type { AuditEntry, AuditPage } from '../api/types';
import { Block } from '../ui/Block';
import { Banner, EmptyRow, Notice, Panel } from '../ui/primitives';
import { useResource } from '../hooks/useResource';
import { ru } from '../i18n/ru';
import { formatDateTime } from '../lib/format';
import { auditDiffs, isServiceActor } from '../lib/auditDiff';
import { navigate } from '../lib/router';

export interface AuditProps {
  readonly api: AdminApi;
  /** Параметры из хеша (`#audit?entity=grant`): они же — состояние фильтров. */
  readonly query: Readonly<Record<string, string>>;
}

const KEYS = ['entity', 'action', 'actor_tg_id', 'limit'] as const;

function toQueryPatch(values: Record<string, string>): Record<string, string | undefined> {
  const patch: Record<string, string | undefined> = {};
  for (const key of KEYS) {
    const value = (values[key] ?? '').trim();
    patch[key] = value === '' ? undefined : value;
  }
  return patch;
}

/** Значения фильтра из хеша — типизированные: `limit` только целое, иначе не уходит. */
function auditQueryFrom(query: Readonly<Record<string, string>>): AuditQuery {
  const limit = /^\d+$/.test(query.limit ?? '') ? Number(query.limit) : null;
  return {
    entity: query.entity ?? null,
    action: query.action ?? null,
    actor_tg_id: query.actor_tg_id ?? null,
    limit,
  };
}

export function Audit({ api, query }: AuditProps) {
  const qs = JSON.stringify(query);
  // `query` приходит из состояния хеш-роутера и сохраняет идентичность до
  // следующей смены хеша — `base` пересобирается ровно тогда же. Иначе
  // `load` менялся бы на каждый рендер, и `useResource` зациклил бы запросы.

  const base = useMemo(() => auditQueryFrom(query), [query]);

  const load = useCallback(
    async (signal: AbortSignal) => {
      const result = await api.audit(base, signal);
      return { data: result.data, demo: result.demo, requestId: result.requestId };
    },
    [api, base],
  );
  const { state, reload } = useResource<AuditPage>(load, { routeKey: 'auditList' });

  // «Показать ещё» дописывает страницы поверх базовой. Накопленное привязано
  // к ключу среза (`qs`): при смене фильтра ссылки на курсоры старого среза
  // бессмысленны, и сброс происходит сам — сравнением ключа, без счётчика
  // перече­тываний (счётчик «взрослел» бы и на первом рендере, оставив ленту
  // без кнопки «Показать ещё»).
  const [extra, setExtra] = useState<{ readonly key: string; readonly pages: readonly (readonly AuditEntry[])[]; readonly next: string | null }>({
    key: qs,
    pages: [],
    next: null,
  });
  const [busyMore, setBusyMore] = useState(false);
  // Ошибка «показать ещё» привязана к срезу: после смены фильтра старая
  // сообщение исчезает само, без эффекта-сброса (лишний рендер на ровном месте).
  const [moreError, setMoreError] = useState<{ readonly key: string; readonly text: string } | null>(null);

  const onSlice = extra.key === qs;
  const nextCursor =
    state.kind === 'ok' && onSlice ? (extra.pages.length > 0 ? extra.next : state.data.next_cursor) : null;

  const items: readonly AuditEntry[] = state.kind === 'ok' ? [...state.data.items, ...(onSlice ? extra.pages.flat() : [])] : [];

  const loadMore = useCallback(async () => {
    if (nextCursor === null || busyMore) return;
    setBusyMore(true);
    setMoreError(null);
    try {
      const result = await api.audit({ ...base, cursor: nextCursor });
      // Срез мог измениться, пока летел запрос: в этом случае новая страница
      // относится уже к нему, и старое накопленное выбрасывается.
      setExtra((prev) => ({ key: qs, pages: prev.key === qs ? [...prev.pages, result.data.items] : [result.data.items], next: result.data.next_cursor }));
    } catch (error) {
      setMoreError({ key: qs, text: toApiError(error, 'GET /api/v1/admin/audit').message });
    } finally {
      setBusyMore(false);
    }
  }, [api, base, busyMore, nextCursor, qs]);

  return (
    <>
      <h1>{ru.audit.heading}</h1>
      <p className="lead">{ru.audit.lead}</p>
      <Banner level="info" title={ru.audit.appendOnly} />
      <div className="grid">
        <Panel title={ru.audit.filters} anchor="filters">
          <Notice>{ru.audit.cursorLead}</Notice>
          <FilterForm key={qs} initial={query} />
          <p className="muted">{ru.audit.filterHint}</p>
        </Panel>

        <Panel title={ru.audit.heading} anchor="journal" onReload={reload}>
          <Block state={state} onReload={reload} empty={ru.audit.empty} isEmpty={(page) => page.items.length === 0}>
            {() => (
              <table>
                <thead>
                  <tr>
                    <th>{ru.audit.when}</th>
                    <th>{ru.audit.who}</th>
                    <th>{ru.audit.what}</th>
                    <th>{ru.audit.object}</th>
                    <th>{ru.audit.delta}</th>
                    <th>{ru.audit.reason}</th>
                    <th>{ru.audit.rid}</th>
                  </tr>
                </thead>
                <tbody>
                  {items.length === 0 ? <EmptyRow colSpan={7} text={ru.audit.empty} /> : null}
                  {items.map((entry) => (
                    <AuditRow key={entry.id} entry={entry} />
                  ))}
                </tbody>
              </table>
            )}
          </Block>
          {state.kind === 'ok' && items.length > 0 ? (
            <div className="row" style={{ marginTop: 8 }}>
              {nextCursor !== null ? (
                <button type="button" onClick={() => void loadMore()} disabled={busyMore}>
                  {busyMore ? ru.audit.loadingMore : ru.audit.more}
                </button>
              ) : (
                <span className="muted">{ru.audit.end}</span>
              )}
            </div>
          ) : null}
          {moreError !== null && moreError.key === qs ? <Banner level="crit" title={moreError.text} /> : null}
        </Panel>
      </div>
    </>
  );
}

function AuditRow({ entry }: { entry: AuditEntry }) {
  const diff = auditDiffs(entry.before, entry.after);
  return (
    <tr>
      <td className="muted">{formatDateTime(entry.at)}</td>
      <td>
        {entry.actor_name}{' '}
        {isServiceActor(entry.actor_tg_id) ? (
          <span className="muted">({ru.audit.service})</span>
        ) : (
          <span className="muted mono">{entry.actor_tg_id}</span>
        )}
      </td>
      <td className="mono">{entry.action}</td>
      <td className="mono">
        {entry.entity}
        {entry.entity_id !== null && entry.entity_id !== undefined ? ` · ${entry.entity_id}` : ''}
      </td>
      <td>
        {diff.length === 0 ? (
          <span className="muted">{ru.audit.noDelta}</span>
        ) : (
          <ul className="tight mono">
            {diff.map((row) => (
              <li key={row.field}>
                {row.field}: {row.from} → {row.to}
              </li>
            ))}
          </ul>
        )}
      </td>
      <td>{entry.reason ?? <span className="muted">{ru.audit.noDelta}</span>}</td>
      <td>
        {entry.request_id !== null && entry.request_id !== undefined ? (
          <span className="mono">{entry.request_id}</span>
        ) : (
          <span className="muted">{ru.audit.noDelta}</span>
        )}
      </td>
    </tr>
  );
}

/** Форма фильтров: значения — из хеша, отправка — `navigate` (хеш обновится, экран перезагрузит блок). */
function FilterForm({ initial }: { readonly initial: Readonly<Record<string, string>> }) {
  const [values, setValues] = useState<Record<string, string>>({
    entity: initial.entity ?? '',
    action: initial.action ?? '',
    actor_tg_id: initial.actor_tg_id ?? '',
    limit: initial.limit ?? '',
  });

  return (
    <form
      className="flow"
      onSubmit={(event) => {
        event.preventDefault();
        navigate('audit', toQueryPatch(values));
      }}
    >
      <div className="row">
        <label className="field">
          {ru.audit.filterEntity}
          <input type="text" maxLength={40} value={values.entity ?? ''} onChange={(event) => { setValues({ ...values, entity: event.target.value }); }} />
        </label>
        <label className="field">
          {ru.audit.filterAction}
          <input type="text" maxLength={60} value={values.action ?? ''} onChange={(event) => { setValues({ ...values, action: event.target.value }); }} />
        </label>
      </div>
      <div className="row">
        <label className="field">
          {ru.audit.filterActor}
          <input type="text" maxLength={24} value={values.actor_tg_id ?? ''} onChange={(event) => { setValues({ ...values, actor_tg_id: event.target.value }); }} />
        </label>
        <label className="field">
          {ru.audit.filterLimit}
          <input type="text" inputMode="numeric" maxLength={6} value={values.limit ?? ''} onChange={(event) => { setValues({ ...values, limit: event.target.value }); }} />
        </label>
      </div>
      <div className="row">
        <button type="submit" className="primary">{ru.audit.apply}</button>
        <button type="button" onClick={() => { navigate('audit', {}); }}>{ru.audit.reset}</button>
      </div>
    </form>
  );
}
