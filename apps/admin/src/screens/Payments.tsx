/*
 * Экран «Платежи и генерации» (ТЗ §4.4): лента зарядов звёзд и лента разборов.
 * Маршруты `/admin/payments` и `/admin/reports` — из 1.6.16, перегенерация
 * (`POST /admin/reports/{id}/regenerate`) — оттуда же.
 *
 * Что здесь решено контрактом, а не панелью:
 *   • одиночного `GET /admin/payments/{id}` нет — поиск по `charge_id` идёт
 *     фильтром списка, и экран не делает вид, что умеет «открыть платёж»;
 *   • страниц по номеру нет: листать можно только `next_cursor`, и «Показать
 *     ещё» — единственная кнопка листания;
 *   • `regenerate` отвечает `202`: разбор становится «в очереди», а не
 *     «готово» — текст появится, когда его покажет лента;
 *   • возврата на этом экране нет: он живёт в карточке человека.
 */

import { useCallback, useState } from 'react';
import type { AdminApi } from '../api/admin';
import { ApiError } from '../api/errors';
import type { AdminPaymentEntry, AdminPaymentsPage, AdminReportSummary, PaymentsQuery, ReportsQuery } from '../api/types';
import { Block } from '../ui/Block';
import { RouteGaps } from '../ui/RouteGaps';
import { HoldConfirm } from '../ui/HoldConfirm';
import { Banner, EmptyRow, Notice, Panel, Pill } from '../ui/primitives';
import { useResource } from '../hooks/useResource';
import { ru } from '../i18n/ru';
import { EMPTY, formatDateTime, formatInt, formatRub, formatStars } from '../lib/format';

export interface PaymentsProps {
  readonly api: AdminApi;
  readonly sessionLive: boolean;
  readonly demo: boolean;
}

const PAYMENT_STATUSES = ['paid', 'processed', 'refunded', 'failed'] as const;
const REPORT_STATUSES = ['queued', 'planning', 'writing', 'ready', 'failed', 'refunded'] as const;
const REPORT_KINDS = ['report', 'compat', 'solar'] as const;

type PaymentStatus = (typeof PAYMENT_STATUSES)[number];
type ReportStatus = (typeof REPORT_STATUSES)[number];
type ReportKind = (typeof REPORT_KINDS)[number];

export function Payments({ api, sessionLive, demo }: PaymentsProps) {
  return (
    <>
      <h1>{ru.payments.heading}</h1>
      <p className="lead">{ru.payments.lead}</p>
      <div className="grid">
        <ChargesPanel api={api} sessionLive={sessionLive} demo={demo} />
        <ReportsPanel api={api} sessionLive={sessionLive} demo={demo} />
        <RouteGaps screen="payments" anchor="gaps" />
      </div>
    </>
  );
}

/** Одна прочитанная страница ленты: её курсор и есть продолжение. */
interface Page {
  readonly items: readonly AdminPaymentEntry[];
  readonly next_cursor: string | null;
}

function ChargesPanel({ api, sessionLive, demo }: { api: AdminApi; sessionLive: boolean; demo: boolean }) {
  const [query, setQuery] = useState<PaymentsQuery | null>(null);
  const [draft, setDraft] = useState<{ charge_id: string; status: PaymentStatus | ''; limit: string }>({
    charge_id: '',
    status: '',
    limit: '20',
  });
  const [pages, setPages] = useState<readonly Page[]>([]);
  const [moreError, setMoreError] = useState<string | null>(null);
  const [busyMore, setBusyMore] = useState(false);

  const load = useCallback(
    async (signal: AbortSignal) => {
      const result = await api.payments(query ?? undefined, signal);
      return { data: result.data, demo: result.demo, requestId: result.requestId };
    },
    [api, query],
  );
  const { state, reload } = useResource<AdminPaymentsPage>(load, {
    routeKey: 'paymentsList',
    enabled: sessionLive,
    allowMissing: demo,
  });

  const apply = useCallback(() => {
    // Пустые фильтры в запрос не попадают вовсе: `charge_id=` сервер прочитал
    // бы как «подстрока пустая» и ответил 422 invalid_filter.
    const next: PaymentsQuery = {};
    if (draft.charge_id.trim() !== '') next.charge_id = draft.charge_id.trim();
    if (draft.status !== '') next.status = draft.status;
    const limit = Number(draft.limit.trim());
    if (draft.limit.trim() !== '' && Number.isInteger(limit) && limit >= 1 && limit <= 100) next.limit = limit;
    setPages([]);
    setMoreError(null);
    setQuery(next);
  }, [draft]);

  const items: readonly AdminPaymentEntry[] = state.kind === 'ok' ? [...state.data.items, ...pages.flatMap((page) => page.items)] : [];
  const lastCursor = state.kind === 'ok' ? (pages.length > 0 ? pages[pages.length - 1]?.next_cursor ?? null : state.data.next_cursor) : null;

  const loadMore = useCallback(async () => {
    if (lastCursor === null || busyMore) return;
    setBusyMore(true);
    setMoreError(null);
    try {
      const result = await api.payments({ ...(query ?? {}), cursor: lastCursor });
      setPages((current) => [...current, { items: result.data.items, next_cursor: result.data.next_cursor }]);
    } catch (error) {
      setMoreError(error instanceof ApiError ? `${error.message} (${error.code})` : String(error));
    } finally {
      setBusyMore(false);
    }
  }, [api, busyMore, lastCursor, query]);

  return (
    <Panel title={ru.payments.charges} anchor="charges" onReload={reload} busy={state.kind === 'loading'}>
      <Notice>{ru.payments.chargeLead}</Notice>
      <form
        className="row"
        style={{ gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}
        onSubmit={(event) => {
          event.preventDefault();
          apply();
        }}
      >
        <label className="field">
          {ru.payments.filterCharge}
          <input type="text" value={draft.charge_id} onChange={(event) => { setDraft({ ...draft, charge_id: event.target.value }); }} />
        </label>
        <label className="field">
          {ru.payments.filterStatus}
          <select value={draft.status} onChange={(event) => { setDraft({ ...draft, status: event.target.value as PaymentStatus | '' }); }}>
            <option value="">—</option>
            {PAYMENT_STATUSES.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          {ru.payments.filterLimit}
          <input type="text" inputMode="numeric" value={draft.limit} onChange={(event) => { setDraft({ ...draft, limit: event.target.value }); }} />
        </label>
        <button type="submit" disabled={!sessionLive}>
          {ru.payments.apply}
        </button>
      </form>

      <Block state={state} onReload={reload} empty={ru.payments.chargesEmpty} isEmpty={() => items.length === 0}>
        {() => (
          <>
            <table>
              <thead>
                <tr>
                  <th>{ru.payments.colCharge}</th>
                  <th>{ru.payments.colUser}</th>
                  <th>{ru.payments.colPlan}</th>
                  <th className="num">{ru.payments.colStars}</th>
                  <th>{ru.payments.colStatus}</th>
                  <th>{ru.payments.colCreated}</th>
                  <th>{ru.payments.colRefunded}</th>
                </tr>
              </thead>
              <tbody>
                {items.length === 0 ? <EmptyRow colSpan={7} text={ru.payments.chargesEmpty} /> : null}
                {items.map((row, index) => (
                  <tr key={`${row.charge_id}-${index}`}>
                    <td className="mono">{row.charge_id}</td>
                    {/* `user_id: null` — это «сервер не назвал человека», а не «человека нет». */}
                    <td className="mono">{row.user_id ?? EMPTY}</td>
                    <td className="mono">{row.plan_code}</td>
                    <td className="num">{formatStars(row.amount_stars)}</td>
                    <td>
                      <Pill tone={row.status === 'failed' ? 'crit' : row.status === 'refunded' ? 'warn' : 'ok'}>{row.status}</Pill>
                      <div className="muted mono">{row.currency}</div>
                    </td>
                    <td className="muted">{formatDateTime(row.created_at)}</td>
                    <td className="muted">{row.refunded_at === null ? EMPTY : formatDateTime(row.refunded_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="row" style={{ gap: 8 }}>
              {lastCursor !== null ? (
                <button type="button" disabled={busyMore} onClick={() => { void loadMore(); }}>
                  {busyMore ? ru.payments.loadingMore : ru.payments.more}
                </button>
              ) : (
                <span className="muted">{ru.payments.end}</span>
              )}
            </div>
            {moreError !== null ? <Banner level="crit" title={moreError} /> : null}
            <p className="muted">{ru.payments.cursorLead}</p>
          </>
        )}
      </Block>
    </Panel>
  );
}

function ReportsPanel({ api, sessionLive, demo }: { api: AdminApi; sessionLive: boolean; demo: boolean }) {
  const [query, setQuery] = useState<ReportsQuery | null>(null);
  const [draft, setDraft] = useState<{ status: ReportStatus | ''; kind: ReportKind | '' }>({ status: '', kind: '' });
  const [message, setMessage] = useState<{ level: 'ok' | 'warn' | 'crit'; text: string } | null>(null);

  const load = useCallback(
    async (signal: AbortSignal) => {
      const result = await api.reports(query ?? undefined, signal);
      return { data: result.data, demo: result.demo, requestId: result.requestId };
    },
    [api, query],
  );
  const { state, reload } = useResource<{ items: readonly AdminReportSummary[]; truncated: boolean }>(load, {
    routeKey: 'reportsList',
    enabled: sessionLive,
    allowMissing: demo,
  });

  const apply = useCallback(() => {
    const next: ReportsQuery = {};
    if (draft.status !== '') next.status = draft.status;
    if (draft.kind !== '') next.kind = draft.kind;
    setMessage(null);
    setQuery(next);
  }, [draft]);

  return (
    <Panel title={ru.payments.reports} anchor="reports" onReload={reload} busy={state.kind === 'loading'}>
      <Notice>{ru.payments.reportsLead}</Notice>
      <form
        className="row"
        style={{ gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}
        onSubmit={(event) => {
          event.preventDefault();
          apply();
        }}
      >
        <label className="field">
          {ru.payments.filterReportStatus}
          <select value={draft.status} onChange={(event) => { setDraft({ ...draft, status: event.target.value as ReportStatus | '' }); }}>
            <option value="">—</option>
            {REPORT_STATUSES.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          {ru.payments.filterReportKind}
          <select value={draft.kind} onChange={(event) => { setDraft({ ...draft, kind: event.target.value as ReportKind | '' }); }}>
            <option value="">—</option>
            {REPORT_KINDS.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" disabled={!sessionLive}>
          {ru.payments.apply}
        </button>
      </form>

      {message === null ? null : <Banner level={message.level} title={message.text} />}

      <Block state={state} onReload={reload} empty={ru.payments.reportsEmpty} isEmpty={(page) => page.items.length === 0}>
        {(page) => (
          <>
            {page.truncated ? <p className="muted">{ru.users.truncated}</p> : null}
            <table>
              <thead>
                <tr>
                  <th>{ru.payments.colKind}</th>
                  <th>{ru.payments.colStatus}</th>
                  <th>{ru.payments.colError}</th>
                  <th className="num">{ru.payments.colAttempts}</th>
                  <th className="num">{ru.payments.colCost}</th>
                  <th>{ru.payments.colUpdated}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {page.items.length === 0 ? <EmptyRow colSpan={7} text={ru.payments.reportsEmpty} /> : null}
                {page.items.map((row) => (
                  <tr key={row.id}>
                    <td>{reportKindLabel(row.kind)}</td>
                    <td>
                      <Pill tone={row.status === 'failed' ? 'crit' : row.status === 'ready' ? 'ok' : 'muted'}>{reportStatusLabel(row.status)}</Pill>
                    </td>
                    <td className="mono">{row.error_code ?? EMPTY}</td>
                    <td className="num">{formatInt(row.attempts)}</td>
                    <td className="num">{formatRub(row.cost_rub)}</td>
                    <td className="muted">{formatDateTime(row.updated_at)}</td>
                    <td>{row.status === 'failed' ? <RegenerateButton api={api} row={row} onDone={reload} onMessage={setMessage} /> : null}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="muted">{ru.payments.regenerateLead}</p>
          </>
        )}
      </Block>
    </Panel>
  );
}

/**
 * Перегенерация: два нажатия (`HoldConfirm`), ответ `202` — «в очереди».
 * Основание у маршрута не спрашивают: тело запроса в контракта нет, вся
 * причина остаётся в аудите сервера.
 */
function RegenerateButton({
  api,
  row,
  onDone,
  onMessage,
}: {
  api: AdminApi;
  row: AdminReportSummary;
  onDone: () => void;
  onMessage: (next: { level: 'ok' | 'warn' | 'crit'; text: string }) => void;
}) {
  const [busy, setBusy] = useState(false);

  const run = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await api.reportRegenerate(row.id);
      onMessage({
        level: 'ok',
        text: `${ru.payments.regenerateQueued} · ${row.id} · ${ru.payments.regenerateState}: ${result.data.state} · ${ru.payments.regenerateAttempts} ${formatInt(result.data.attempts)}`,
      });
      onDone();
    } catch (error) {
      const text =
        error instanceof ApiError ? `${error.message}${error.reason ? ` (${error.reason})` : ''}` : String(error);
      onMessage({ level: error instanceof ApiError && error.status === 409 ? 'warn' : 'crit', text });
    } finally {
      setBusy(false);
    }
  }, [api, busy, onDone, onMessage, row.id]);

  return (
    <HoldConfirm
      label={busy ? ru.payments.regenerateBusy : ru.payments.regenerate}
      busy={busy}
      onExecute={() => { void run(); }}
    >
      <p className="confirm__delta">
        {ru.payments.colKind}: {reportKindLabel(row.kind)} · {ru.payments.colAttempts} {formatInt(row.attempts)}
      </p>
      <p className="muted">{ru.payments.regenerateNote}</p>
    </HoldConfirm>
  );
}

function reportStatusLabel(status: ReportStatus): string {
  switch (status) {
    case 'queued':
      return ru.payments.stateQueued;
    case 'planning':
      return ru.payments.statePlanning;
    case 'writing':
      return ru.payments.stateWriting;
    case 'ready':
      return ru.payments.stateReady;
    case 'failed':
      return ru.payments.stateFailed;
    case 'refunded':
      return ru.payments.stateRefunded;
  }
}

function reportKindLabel(kind: ReportKind): string {
  switch (kind) {
    case 'report':
      return ru.payments.kindReport;
    case 'compat':
      return ru.payments.kindCompat;
    case 'solar':
      return ru.payments.kindSolar;
  }
}
