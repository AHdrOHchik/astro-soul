/*
 * Экран «Основатели и партнёры» (ТЗ §4.5): места «первых 50» и агрегаты по
 * партнёрским кодам. Оба маршрута (`GET /admin/founders`, `GET /admin/partners`)
 * пришли в 1.6.17; панель на них только читает — правок здесь нет.
 *
 * Колонки ровно по ответу сервера:
 *   • «ник» нет: поля `username` в `AdminFounder` с 1.6.18 не существует,
 *     поэтому колонку показывать нечем — человека называют `telegram_id`;
 *   • `revenue_stars` подписана «без учёта возвратов»: платёж со статусом
 *     `refunded` в сумму не входит, и отдельной цифры возвратов здесь нет;
 *   • ноль и «данных нет» различаются видимым образом: `expires_at: null` —
 *     «—», а не «истекло».
 */

import { useCallback, useState } from 'react';
import type { AdminApi } from '../api/admin';
import type { AdminFounder, AdminPartner, FoundersQuery } from '../api/types';
import { Block } from '../ui/Block';
import { EmptyRow, Notice, Panel, Pill } from '../ui/primitives';
import { useResource } from '../hooks/useResource';
import { ru } from '../i18n/ru';
import { EMPTY, formatDateTime, formatInt } from '../lib/format';

export interface FoundersProps {
  readonly api: AdminApi;
  readonly sessionLive: boolean;
  readonly demo: boolean;
}

export function Founders({ api, sessionLive, demo }: FoundersProps) {
  const [limit, setLimit] = useState('50');
  const [query, setQuery] = useState<FoundersQuery | null>(null);

  const loadFounders = useCallback(
    async (signal: AbortSignal) => {
      const result = await api.founders(query ?? undefined, signal);
      return { data: result.data, demo: result.demo, requestId: result.requestId };
    },
    [api, query],
  );
  const founders = useResource<{ items: readonly AdminFounder[]; next_cursor: string | null }>(loadFounders, {
    routeKey: 'foundersList',
    enabled: sessionLive,
    allowMissing: demo,
  });

  const loadPartners = useCallback(
    async (signal: AbortSignal) => {
      const result = await api.partners(signal);
      return { data: result.data.items, demo: result.demo, requestId: result.requestId };
    },
    [api],
  );
  const partners = useResource<readonly AdminPartner[]>(loadPartners, {
    routeKey: 'partnersStats',
    enabled: sessionLive,
    allowMissing: demo,
  });

  const apply = useCallback(() => {
    const value = Number(limit.trim());
    const next: FoundersQuery = {};
    // Вне диапазона 1..100 сервер отвечает 422 — поле просто не уходит.
    if (limit.trim() !== '' && Number.isInteger(value) && value >= 1 && value <= 100) next.limit = value;
    setQuery(next);
    founders.reload();
  }, [founders, limit]);

  return (
    <>
      <h1>{ru.founders.heading}</h1>
      <p className="lead">{ru.founders.lead}</p>
      <div className="grid">
        <Panel title={ru.founders.places} anchor="places" onReload={founders.reload} busy={founders.state.kind === 'loading'}>
          <Notice>{ru.founders.placesLead}</Notice>
          <form
            className="row"
            style={{ gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}
            onSubmit={(event) => {
              event.preventDefault();
              apply();
            }}
          >
            <label className="field">
              {ru.payments.filterLimit}
              <input type="text" inputMode="numeric" value={limit} onChange={(event) => { setLimit(event.target.value); }} />
            </label>
            <button type="submit" disabled={!sessionLive}>
              {ru.payments.apply}
            </button>
          </form>
          <Block
            state={founders.state}
            onReload={founders.reload}
            empty={ru.founders.placesEmpty}
            isEmpty={(page) => page.items.length === 0}
          >
            {(page) => (
              <>
                <table>
                  <thead>
                    <tr>
                      <th className="num">{ru.founders.colPlace}</th>
                      <th>{ru.founders.colTg}</th>
                      <th>{ru.founders.colUser}</th>
                      <th>{ru.founders.colCreated}</th>
                      <th>{ru.founders.colGrant}</th>
                      <th>{ru.founders.colExpires}</th>
                      <th>{ru.founders.colCode}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {page.items.length === 0 ? <EmptyRow colSpan={7} text={ru.founders.placesEmpty} /> : null}
                    {page.items.map((row) => (
                      <tr key={`${row.place}`}>
                        <td className="num mono">{formatInt(row.place)}</td>
                        <td className="mono">{row.telegram_id}</td>
                        <td className="mono">{row.user_id}</td>
                        <td className="muted">{formatDateTime(row.created_at)}</td>
                        <td>{row.grant_kind ?? ru.founders.grantNone}</td>
                        <td className="muted">{row.expires_at === null ? EMPTY : formatDateTime(row.expires_at)}</td>
                        <td>
                          <Pill tone={row.code_activated ? 'ok' : 'muted'}>
                            {row.code_activated ? ru.founders.codeYes : ru.founders.codeNo}
                          </Pill>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="muted">{ru.founders.nickColumnHidden}</p>
                {page.next_cursor !== null ? <p className="muted">{ru.payments.cursorLead}</p> : <p className="muted">{ru.payments.end}</p>}
              </>
            )}
          </Block>
        </Panel>

        <Panel title={ru.founders.partners} anchor="partners" onReload={partners.reload} busy={partners.state.kind === 'loading'}>
          <Notice>{ru.founders.partnersLead}</Notice>
          <Block state={partners.state} onReload={partners.reload} empty={ru.founders.partnersEmpty} isEmpty={(items) => items.length === 0}>
            {(items) => (
              <>
                <table>
                  <thead>
                    <tr>
                      <th>{ru.founders.colPartner}</th>
                      <th className="num">{ru.founders.colCodes}</th>
                      <th className="num">{ru.founders.colActivations}</th>
                      <th className="num">{ru.founders.colUsers}</th>
                      <th className="num">{ru.founders.colPaid}</th>
                      <th className="num">{ru.founders.colRevenue}</th>
                      <th>{ru.founders.colLastActivation}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.length === 0 ? <EmptyRow colSpan={7} text={ru.founders.partnersEmpty} /> : null}
                    {items.map((row) => (
                      <tr key={row.partner_name}>
                        <td className="mono">{row.partner_name}</td>
                        <td className="num">{formatInt(row.codes_total)}</td>
                        <td className="num">{formatInt(row.activations_total)}</td>
                        <td className="num">{formatInt(row.activated_users)}</td>
                        <td className="num">{formatInt(row.paid_users)}</td>
                        <td className="num">{formatInt(row.revenue_stars)}</td>
                        <td className="muted">
                          {row.last_activation_at === null ? ru.founders.zeroActivations : formatDateTime(row.last_activation_at)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="muted">{ru.founders.revenueNote}</p>
              </>
            )}
          </Block>
        </Panel>
      </div>
    </>
  );
}
