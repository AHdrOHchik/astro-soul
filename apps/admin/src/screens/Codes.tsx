/*
 * Экран «Коды и гранты» (ТЗ §4.5). Единственная часть панели, которая
 * работает по-настоящему уже сегодня: `GET/POST /admin/codes` и
 * `GET/POST /admin/grants` есть в контракте 1.6.14.
 *
 * Что здесь запрещено:
 *   • показывать чужие ПДн — карточку человека открывает другой экран, и то по
 *     обращению в поддержку; здесь только `user_id` (uuid) и метка партнёра;
 *   • «пакет из N кодов» одним запросом: сервер создаёт по одному кода, и
 *     панель делает ровно N запросов, без повторов и без отката;
 *   • отзывать право одним кликом: отзыв идёт через двухшаговое подтверждение
 *     (`src/lib/confirm.ts`), где решение принимает автомат, а не кнопка.
 */

import { useCallback, useState } from 'react';
import { CODE_BATCH_MAX, createCodeBatch, GRANT_KINDS, type AdminApi, type BatchResult } from '../api/admin';
import { ApiError } from '../api/errors';
import type { AccessCode, GrantKind, GrantRow } from '../api/types';
import { CopyButton } from '../ui/CopyChip';
import { Block } from '../ui/Block';
import { HoldConfirm } from '../ui/HoldConfirm';
import { Banner, EmptyRow, Notice, Panel, Pill } from '../ui/primitives';
import { useResource } from '../hooks/useResource';
import { ru } from '../i18n/ru';
import { EMPTY, endOfDayUtc, formatDate, formatDateTime, formatInt, formatUsage } from '../lib/format';
import { codeState, CODE_STATE_LABEL, grantState, GRANT_STATE_LABEL, isUuid } from '../lib/selectors';

const KIND_LABEL: Record<GrantKind, string> = {
  all_access: ru.kinds.all_access,
  single_report: ru.kinds.single_report,
  single_compat: ru.kinds.single_compat,
};

const CODE_TONE: Record<string, 'ok' | 'warn' | 'crit' | 'muted'> = {
  active: 'ok',
  expired: 'warn',
  exhausted: 'warn',
  inactive: 'muted',
};

const GRANT_TONE: Record<string, 'ok' | 'warn' | 'crit' | 'muted'> = {
  active: 'ok',
  used: 'muted',
  expired: 'warn',
  // Отозванное право — это история, а не авария: красный только для действий,
  // а не для фактов.
  revoked: 'warn',
};

export function grantTone(state: string): 'ok' | 'warn' | 'crit' | 'muted' {
  return GRANT_TONE[state] ?? 'muted';
}

/** Ревизии пользователя нет, и «всё переписать» опасно: меняем только явно названное. */
function grantLabel(kind: GrantKind, expires: string | null | undefined): string {
  return `${KIND_LABEL[kind]} · ${expires ? `до ${formatDate(expires)}` : 'срок не ограничен'}`;
}

export interface CodesProps {
  readonly api: AdminApi;
  readonly sessionLive: boolean;
  readonly now: number;
}

export function Codes({ api, sessionLive, now }: CodesProps) {
  const { state, reload } = useResource<readonly AccessCode[]>(
    useCallback(
      async (signal) => {
        const result = await api.codes(signal);
        return { data: result.data, demo: result.demo, requestId: result.requestId };
      },
      [api],
    ),
    { routeKey: 'codesList', enabled: sessionLive },
  );

  return (
    <>
      <h1>{ru.codes.heading}</h1>
      <p className="lead">{ru.codes.lead}</p>
      <div className="grid">
        <Panel title={ru.codes.list} anchor="codes" onReload={reload} busy={state.kind === 'loading'}>
          <CodesTable state={state} now={now} onReload={reload} disabled={!sessionLive} />
        </Panel>
        <CreateCodesPanel api={api} sessionLive={sessionLive} onCreated={reload} />
      </div>
      <div className="grid" style={{ marginTop: 12 }}>
        <GrantsPanel api={api} sessionLive={sessionLive} now={now} />
        <GrantIssuePanel api={api} sessionLive={sessionLive} onIssued={() => { reload(); }} />
      </div>
    </>
  );
}

function CodesTable({
  state,
  now,
  onReload,
  disabled,
}: {
  state: ReturnType<typeof useResource<readonly AccessCode[]>>['state'];
  now: number;
  onReload: () => void;
  disabled: boolean;
}) {
  if (disabled) return <Banner level="warn" title={ru.states.unauthorized}>{ru.overview.publicOnly}</Banner>;

  return (
    <Block state={state} onReload={onReload} empty={ru.codes.listEmpty} isEmpty={(items) => items.length === 0}>
      {(items) => (
        <table>
          <thead>
            <tr>
              <th>{ru.codes.code}</th>
              <th>{ru.codes.kind}</th>
              <th className="num">{ru.codes.days}</th>
              <th className="num">{ru.codes.activations}</th>
              <th>{ru.codes.partner}</th>
              <th>{ru.codes.expires}</th>
              <th>{ru.codes.status}</th>
              <th>{ru.codes.created}</th>
            </tr>
          </thead>
          <tbody>
            {items.length === 0 ? <EmptyRow colSpan={8} text={ru.codes.listEmpty} /> : null}
            {items.map((code) => {
              const status = codeState(code, now);
              return (
                <tr key={code.id}>
                  <td>
                    <span className="mono">{code.code}</span>{' '}
                    <CopyButton value={code.code} title={code.code} />
                  </td>
                  <td>{KIND_LABEL[code.kind]}</td>
                  <td className="num">{formatInt(code.days)}</td>
                  <td className="num">{formatUsage(code.activations, code.max_activations)}</td>
                  <td>{code.partner_name ?? EMPTY}</td>
                  <td>{code.expires_at ? formatDate(code.expires_at) : EMPTY}</td>
                  <td>
                    <Pill tone={CODE_TONE[status] ?? 'muted'}>{CODE_STATE_LABEL[status]}</Pill>
                  </td>
                  <td className="muted">{code.created_at ? formatDateTime(code.created_at) : EMPTY}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </Block>
  );
}

function CreateCodesPanel({ api, sessionLive, onCreated }: { api: AdminApi; sessionLive: boolean; onCreated: () => void }) {
  const [form, setForm] = useState({ kind: 'single_report', days: '30', count: '5', maxActivations: '1', partner: '', expires: '' });
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<BatchResult | null>(null);
  const [progress, setProgress] = useState('');

  const needsDays = form.kind === 'all_access';
  const days = Number(form.days);
  const count = Number(form.count);
  const maxActivations = Number(form.maxActivations);
  const expiresAt = form.expires === '' ? null : endOfDayUtc(form.expires);

  const invalid =
    (needsDays && (!Number.isInteger(days) || days < 1 || days > 3650)) ||
    !Number.isInteger(count) ||
    count < 1 ||
    count > CODE_BATCH_MAX ||
    !Number.isInteger(maxActivations) ||
    maxActivations < 1 ||
    (form.expires !== '' && expiresAt === null);

  const submit = useCallback(async () => {
    if (invalid || busy) return;
    setBusy(true);
    setResult(null);

    const batch = await createCodeBatch(
      api,
      {
        count,
        kind: form.kind as GrantKind,
        days: needsDays ? days : null,
        maxActivations,
        partnerName: form.partner.trim() === '' ? null : form.partner.trim(),
        expiresAt,
      },
      (done, total) => { setProgress(`${done} / ${total}`); },
    );

    setResult(batch);
    setBusy(false);
    setProgress('');
    onCreated();
  }, [api, busy, count, days, expiresAt, form.kind, form.partner, invalid, maxActivations, needsDays, onCreated]);

  const all = result?.created.map((code) => code.code).join('\n') ?? '';

  return (
    <Panel title={ru.codes.create.title} anchor="create">
      {!sessionLive ? (
        <Banner level="warn" title={ru.states.unauthorized}>{ru.overview.publicOnly}</Banner>
      ) : (
        <>
          <Notice>{ru.codes.create.lead}</Notice>
          <Banner level="warn" title={ru.codes.create.warning} />
          <form
            className="flow"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <div className="row">
              <label className="field">
                {ru.codes.create.kind}
                <select value={form.kind} onChange={(event) => { setForm({ ...form, kind: event.target.value }); }}>
                  {GRANT_KINDS.map((kind) => (
                    <option key={kind} value={kind}>
                      {KIND_LABEL[kind]}
                    </option>
                  ))}
                </select>
              </label>
              {needsDays ? (
                <label className="field">
                  {ru.codes.create.days}
                  <input
                    type="number"
                    min={1}
                    max={3650}
                    value={form.days}
                    onChange={(event) => { setForm({ ...form, days: event.target.value }); }}
                    aria-invalid={days < 1 || days > 3650}
                  />
                </label>
              ) : null}
              <label className="field">
                {ru.codes.create.count}
                <input
                  type="number"
                  min={1}
                  max={CODE_BATCH_MAX}
                  value={form.count}
                  onChange={(event) => { setForm({ ...form, count: event.target.value }); }}
                  aria-invalid={count < 1 || count > CODE_BATCH_MAX}
                />
              </label>
              <label className="field">
                {ru.codes.create.maxActivations}
                <input
                  type="number"
                  min={1}
                  value={form.maxActivations}
                  onChange={(event) => { setForm({ ...form, maxActivations: event.target.value }); }}
                  aria-invalid={maxActivations < 1}
                />
              </label>
              <label className="field">
                {ru.codes.create.partner}
                <input type="text" maxLength={80} value={form.partner} onChange={(event) => { setForm({ ...form, partner: event.target.value }); }} />
              </label>
              <label className="field">
                {ru.codes.create.expires}
                <input type="date" value={form.expires} onChange={(event) => { setForm({ ...form, expires: event.target.value }); }} />
              </label>
            </div>

            {needsDays && (days < 1 || days > 3650) ? <Banner level="crit" title={ru.codes.create.needsDays} /> : null}

            <div className="row">
              <button type="submit" className="primary" disabled={invalid || busy}>
                {busy ? `${ru.codes.create.submitting}${progress === '' ? '' : ` ${progress}`}` : ru.codes.create.submit}
              </button>
            </div>
          </form>

          {result ? (
            <fieldset>
              <legend>
                {result.stoppedAfter === null
                  ? `${ru.codes.create.done}: ${formatInt(result.created.length)}`
                  : ru.codes.create.partial}
              </legend>
              {result.stoppedAfter !== null ? (
                <Banner level="crit" title={`${ru.codes.create.partialLead} ${stopReason(result.error)}`} />
              ) : null}
              {result.created.length > 0 ? (
                <>
                  <div className="row" style={{ justifyContent: 'flex-end' }}>
                    <CopyButton value={all} label={ru.codes.create.copyAll} />
                  </div>
                  <div className="codes">
                    {result.created.map((code) => (
                      <div key={code.id} className="code">
                        <span className="mono">{code.code}</span>
                        <CopyButton value={code.code} label={ru.codes.create.copyOne} />
                      </div>
                    ))}
                  </div>
                </>
              ) : (
                <Notice>{ru.codes.create.partialLead}</Notice>
              )}
            </fieldset>
          ) : null}
        </>
      )}
    </Panel>
  );
}

/** Причина остановки пакета: серверное сообщение и код, без пересказа своими словами. */
function stopReason(error: unknown): string {
  if (error instanceof ApiError) return `${error.message}${error.reason ? ` (${error.reason})` : ''}`;
  return error instanceof Error ? error.message : String(error);
}

export function GrantsPanel({ api, sessionLive, now }: { api: AdminApi; sessionLive: boolean; now: number }) {
  const [userId, setUserId] = useState('');
  const [submitted, setSubmitted] = useState<string | null>(null);
  const [revoke, setRevoke] = useState<GrantRow | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const valid = submitted !== null && isUuid(submitted);
  const load = useCallback(
    async (signal: AbortSignal) => {
      const result = await api.grants(submitted ?? '', signal);
      return { data: result.data, demo: result.demo, requestId: result.requestId };
    },
    [api, submitted],
  );

  const { state, reload } = useResource<readonly GrantRow[]>(load, { routeKey: 'grantsList', enabled: valid });

  const revokeGrant = useCallback(async () => {
    if (revoke === null || submitted === null) return;
    setBusy(true);
    try {
      await api.grantWrite({ user_id: submitted, kind: revoke.kind, action: 'revoke', grant_id: revoke.id });
      setMessage(`${ru.codes.grants.revoked}: ${grantLabel(revoke.kind, revoke.expires_at)}`);
      setRevoke(null);
      reload();
    } catch (error) {
      setMessage(stopReason(error));
    } finally {
      setBusy(false);
    }
  }, [api, reload, revoke, submitted]);

  return (
    <Panel title={ru.codes.grants.title} anchor="grants">
      <Notice>{ru.codes.grants.lead}</Notice>
      {!sessionLive ? (
        <Banner level="warn" title={ru.states.unauthorized}>{ru.overview.publicOnly}</Banner>
      ) : (
        <>
          <form
            className="row"
            onSubmit={(event) => {
              event.preventDefault();
              setSubmitted(userId.trim());
              setRevoke(null);
              setMessage(null);
            }}
          >
            <label className="field">
              {ru.codes.grants.userId}
              <input
                className="mono"
                type="text"
                value={userId}
                placeholder="00000000-0000-0000-0000-000000000000"
                onChange={(event) => { setUserId(event.target.value); }}
                aria-invalid={userId.trim() !== '' && !isUuid(userId)}
              />
            </label>
            <button type="submit" disabled={busy || !isUuid(userId)}>
              {ru.codes.grants.load}
            </button>
            <span className="muted">{ru.codes.grants.needUserId}</span>
          </form>

          {submitted === null ? null : !isUuid(submitted) ? (
            <Banner level="crit" title={ru.codes.grants.needUserId} />
          ) : (
            <Block state={state} onReload={reload} empty={ru.codes.grants.empty} isEmpty={(items) => items.length === 0}>
              {(items) => (
                <table>
                  <thead>
                    <tr>
                      <th>{ru.codes.kind}</th>
                      <th>{ru.codes.grants.source}</th>
                      <th className="num">{ru.codes.days}</th>
                      <th>{ru.codes.grants.starts}</th>
                      <th>{ru.codes.grants.expires}</th>
                      <th>{ru.codes.grants.state}</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((grant) => {
                      const status = grantState(grant, now);
                      return (
                        <tr key={grant.id}>
                          <td>{KIND_LABEL[grant.kind]}</td>
                          <td>{ru.sources[grant.source]}</td>
                          <td className="num">{formatInt(grant.days)}</td>
                          <td>{grant.starts_at ? formatDate(grant.starts_at) : EMPTY}</td>
                          <td>{grant.expires_at ? formatDate(grant.expires_at) : EMPTY}</td>
                          <td>
                            <Pill tone={grantTone(status)}>{GRANT_STATE_LABEL[status]}</Pill>
                          </td>
                          <td>
                            {status === 'revoked' ? (
                              <span className="muted">{ru.codes.grants.revoked}</span>
                            ) : (
                              <button type="button" onClick={() => { setRevoke(revoke?.id === grant.id ? null : grant); }}>
                                {ru.codes.grants.revoke}
                              </button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </Block>
          )}

          {revoke ? (
            <HoldConfirm label={ru.codes.grants.confirmRevoke} busy={busy} onExecute={revokeGrant}>
              <p className="confirm__delta">{grantLabel(revoke.kind, revoke.expires_at)}</p>
              <p className="muted mono">grant_id {revoke.id}</p>
              <p className="muted">{ru.codes.grants.revokeNeedsTwoSteps}</p>
            </HoldConfirm>
          ) : null}

          {message ? <Banner level="ok" title={message} /> : null}
        </>
      )}
    </Panel>
  );
}

export { KIND_LABEL };


/**
 * Ручная выдача права (ТЗ §4.5). Одно нажатие — не ошибка: выдача не отзывает
 * чужой доступ и не меняет цену, а сервер на ней проверяет и `ADMIN_TG_ID`, и
 * бюджет бесплатного доступа. Ответ показываем целиком (`grant_id`,
 * `expires_at`): админ должен видеть, что именно он выдал.
 */
function GrantIssuePanel({ api, sessionLive, onIssued }: { api: AdminApi; sessionLive: boolean; onIssued: () => void }) {
  const [form, setForm] = useState({ userId: '', kind: 'single_report', days: '30' });
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  const days = Number(form.days);
  const needsDays = form.kind === 'all_access';
  const invalid = !isUuid(form.userId) || busy || (needsDays && (!Number.isInteger(days) || days < 1 || days > 3650));

  const submit = useCallback(async () => {
    if (invalid) return;
    setBusy(true);
    try {
      const issued = await api.grantWrite({
        user_id: form.userId.trim(),
        kind: form.kind as GrantKind,
        ...(needsDays ? { days } : {}),
      });
      setResult({
        ok: true,
        text: `${ru.codes.grants.issue.done}: ${KIND_LABEL[form.kind as GrantKind]} · ${
          issued.data.expires_at ? `до ${formatDate(issued.data.expires_at)}` : 'бессрочно'
        } · grant_id ${issued.data.grant_id}`,
      });
      onIssued();
    } catch (error) {
      setResult({ ok: false, text: stopReason(error) });
    } finally {
      setBusy(false);
    }
  }, [api, days, form.kind, form.userId, invalid, needsDays, onIssued]);

  if (!sessionLive) return null;

  return (
    <Panel title={ru.codes.grants.issue.title} anchor="issue">
      <Notice>{ru.codes.grants.issue.lead}</Notice>
      <form
        className="flow"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="row">
          <label className="field">
            {ru.codes.grants.issue.userId}
            <input
              className="mono"
              type="text"
              value={form.userId}
              onChange={(event) => { setForm({ ...form, userId: event.target.value }); }}
              aria-invalid={form.userId !== '' && !isUuid(form.userId)}
            />
          </label>
          <label className="field">
            {ru.codes.grants.issue.kind}
            <select value={form.kind} onChange={(event) => { setForm({ ...form, kind: event.target.value }); }}>
              {GRANT_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {KIND_LABEL[kind]}
                </option>
              ))}
            </select>
          </label>
          {needsDays ? (
            <label className="field">
              {ru.codes.grants.issue.days}
              <input
                type="number"
                min={1}
                max={3650}
                value={form.days}
                onChange={(event) => { setForm({ ...form, days: event.target.value }); }}
              />
            </label>
          ) : null}
        </div>
        <div className="row">
          <button type="submit" className="primary" disabled={invalid}>
            {busy ? ru.codes.grants.issue.submitting : ru.codes.grants.issue.submit}
          </button>
          {form.userId !== '' && !isUuid(form.userId) ? <span className="muted">{ru.codes.grants.needUserId}</span> : null}
        </div>
      </form>
      {result ? <Banner level={result.ok ? 'ok' : 'crit'} title={result.text} /> : null}
    </Panel>
  );
}
