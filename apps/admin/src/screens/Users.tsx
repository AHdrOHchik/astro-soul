/*
 * Экран «Пользователи» (ТЗ §4.2): поиск ровно одним параметром, карточка
 * человека и три действия — пуш, блокировка с основанием и возврат звёзд.
 * Маршрутов `/admin/users*` в контракте 1.6.14 нет: в проде экран перечисляет
 * недостающие адреса и не рисует данных, в ДЕМО работает на dev-мокере.
 *
 * Запреты, которые держит этот файл:
 *   • поиск отправляется одним параметром — `telegram_id`, `alias` или `q`;
 *     два сразу сервер не принимает, и панель этот ответ сама не создаёт;
 *   • у возврата НЕТ поля «сколько вернуть»: возврат только полный, сумму
 *     считает сервер, экран её показывает и просит повторить как подтверждение;
 *   • блокировка без основания не отправляется, а `409`/`422` сервера
 *     показывается текстом сервера, без пересказа;
 *   • в карточке нет ничего, чего не вернул сервер: ни «примерной» суммы,
 *     ни «вероятного» тарифа.
 */

import { useCallback, useState } from 'react';
import type { AdminApi } from '../api/admin';
import { ApiError } from '../api/errors';
import type { AdminUserCard, AdminUserRow } from '../api/types';
import { Block } from '../ui/Block';
import { HoldConfirm } from '../ui/HoldConfirm';
import { Banner, EmptyRow, KeyValue, Notice, Panel, Pill } from '../ui/primitives';
import { useResource } from '../hooks/useResource';
import { ru } from '../i18n/ru';
import { EMPTY, formatDate, formatDateTime, formatStars } from '../lib/format';
import { buildUsersSearch, echoMatches, type SearchMode } from '../lib/plansUsers';

export interface UsersProps {
  readonly api: AdminApi;
  readonly sessionLive: boolean;
  readonly demo: boolean;
}

export function Users({ api, sessionLive, demo }: UsersProps) {
  const [mode, setMode] = useState<SearchMode>('telegram_id');
  const [raw, setRaw] = useState('');
  const [submitted, setSubmitted] = useState<{ mode: SearchMode; raw: string } | null>(null);
  const [selected, setSelected] = useState<AdminUserRow | null>(null);

  const build = buildUsersSearch(mode, raw);

  const load = useCallback(
    async (signal: AbortSignal) => {
      const request = buildUsersSearch(submitted?.mode ?? 'q', submitted?.raw ?? '');
      if (!request.ok) throw new Error('поиск отправлен без значения');
      const result = await api.usersSearch(request.params, signal);
      return { data: result.data.items, demo: result.demo, requestId: result.requestId };
    },
    [api, submitted],
  );
  const { state, reload } = useResource<readonly AdminUserRow[]>(load, {
    routeKey: 'usersSearch',
    enabled: submitted !== null && sessionLive,
    allowMissing: demo,
  });

  const openCard = useCallback((row: AdminUserRow) => { setSelected(row); }, []);
  const back = useCallback(() => { setSelected(null); }, []);

  if (selected !== null) {
    return (
      <UserCardView api={api} sessionLive={sessionLive} demo={demo} row={selected} onBack={back} />
    );
  }

  return (
    <>
      <h1>{ru.users.heading}</h1>
      <p className="lead">{ru.users.lead}</p>
      <div className="grid">
        <Panel title={ru.users.search.title} anchor="search">
          <Notice>{ru.users.search.lead}</Notice>
          <form
            className="flow"
            onSubmit={(event) => {
              event.preventDefault();
              if (!build.ok) return;
              setSubmitted({ mode, raw });
              setSelected(null);
            }}
          >
            <fieldset>
              <legend>{ru.users.search.input}</legend>
              <div className="row">
                {(['telegram_id', 'alias', 'q'] as const).map((key) => (
                  <label key={key} className="row" style={{ gap: 4 }}>
                    <input
                      type="radio"
                      name="users-search-mode"
                      checked={mode === key}
                      onChange={() => { setMode(key); }}
                    />
                    {key === 'telegram_id' ? ru.users.search.modeTelegram : key === 'alias' ? ru.users.search.modeAlias : ru.users.search.modeText}
                  </label>
                ))}
              </div>
              <input
                type="text"
                value={raw}
                onChange={(event) => { setRaw(event.target.value); }}
                aria-invalid={!build.ok && raw.trim() !== ''}
              />
            </fieldset>
            <div className="row">
              <button type="submit" className="primary" disabled={!build.ok || !sessionLive}>
                {ru.users.search.submit}
              </button>
              {!sessionLive ? <span className="muted">{ru.states.unauthorized}</span> : null}
              {build.ok || raw.trim() === '' ? null : (
                <span className="muted">{build.error === 'telegram_digits' ? ru.users.search.telegramDigits : ru.users.search.needValue}</span>
              )}
            </div>
          </form>
        </Panel>

        <Panel title={ru.users.results} anchor="results" onReload={submitted === null ? undefined : reload} busy={state.kind === 'loading'}>
          {submitted === null ? (
            <Notice>{ru.users.search.lead}</Notice>
          ) : (
            <Block state={state} onReload={reload} empty={ru.users.resultsEmpty} isEmpty={(items) => items.length === 0}>
              {(items) => (
                <table>
                  <thead>
                    <tr>
                      <th>{ru.users.colPerson}</th>
                      <th>{ru.users.colAccess}</th>
                      <th>{ru.users.colState}</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {items.length === 0 ? <EmptyRow colSpan={4} text={ru.users.resultsEmpty} /> : null}
                    {items.map((row) => (
                      <tr key={row.user_id}>
                        <td>
                          {row.name ?? EMPTY}
                          <div className="muted mono">{row.alias === null ? EMPTY : `@${row.alias}`} · {row.tg_id}</div>
                        </td>
                        <td>
                          {row.plan_code ?? EMPTY}
                          <div className="muted">{row.access_until === null ? EMPTY : formatDate(row.access_until)}</div>
                        </td>
                        <td>
                          {row.banned ? <Pill tone="crit">{ru.users.banned}</Pill> : row.plan_code === null ? (
                            <Pill tone="muted">{ru.users.noAccess}</Pill>
                          ) : (
                            <Pill tone="ok">{ru.users.live}</Pill>
                          )}
                        </td>
                        <td>
                          <button type="button" onClick={() => { openCard(row); }}>{ru.users.open}</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Block>
          )}
        </Panel>
      </div>
    </>
  );
}

function UserCardView({
  api,
  sessionLive,
  demo,
  row,
  onBack,
}: {
  api: AdminApi;
  sessionLive: boolean;
  demo: boolean;
  row: AdminUserRow;
  onBack: () => void;
}) {
  const [message, setMessage] = useState<{ level: 'ok' | 'warn' | 'crit'; text: string } | null>(null);

  const load = useCallback(
    async (signal: AbortSignal) => {
      const result = await api.userCard(row.user_id, signal);
      return { data: result.data, demo: result.demo, requestId: result.requestId };
    },
    [api, row.user_id],
  );
  const { state, reload } = useResource<AdminUserCard>(load, {
    routeKey: 'userCard',
    enabled: sessionLive,
    allowMissing: demo,
  });

  const report = useCallback((next: { level: 'ok' | 'warn' | 'crit'; text: string }) => { setMessage(next); }, []);
  const fail = useCallback((error: unknown): { level: 'warn' | 'crit'; text: string } => {
    if (error instanceof ApiError) {
      const detail = `${error.message}${error.reason ? ` (${error.reason})` : ''}${error.requestId ? ` · request_id ${error.requestId}` : ''}`;
      return { level: error.isMissingRoute ? 'warn' : 'crit', text: detail };
    }
    return { level: 'crit', text: String(error) };
  }, []);

  return (
    <>
      <h1>{ru.users.card.title}</h1>
      <div className="row" style={{ marginBottom: 8 }}>
        <button type="button" onClick={onBack}>{ru.users.card.back}</button>
        <span className="muted mono">{row.tg_id}</span>
      </div>
      {message ? <Banner level={message.level} title={message.text} /> : null}
      <div className="grid">
        <Panel title={ru.users.card.profile} anchor="profile" onReload={reload}>
          <Block state={state} onReload={reload}>
            {(card) => (
              <>
                <KeyValue
                  rows={[
                    { label: ru.users.colPerson, value: `${card.name ?? EMPTY} · ${card.alias === null ? EMPTY : `@${card.alias}`}` },
                    { label: ru.users.card.created, value: formatDateTime(card.created_at) },
                    { label: ru.users.card.lastSeen, value: card.last_seen_at === null ? EMPTY : formatDateTime(card.last_seen_at) },
                    {
                      label: ru.users.card.access,
                      value: card.subscription === null ? ru.users.card.noAccessLine : (
                        <>
                          {card.subscription.plan_code} · {formatDate(card.subscription.until)} · {card.subscription.source}
                        </>
                      ),
                    },
                    ...(card.banned_at === null ? [] : [
                      { label: ru.users.card.bannedAt, value: formatDateTime(card.banned_at) },
                      { label: ru.users.card.bannedReason, value: card.ban_reason ?? EMPTY },
                    ]),
                  ]}
                />
                <UserPushRow api={api} card={card} onDone={reload} onFail={fail} onMessage={report} />
                <UserBanRow api={api} card={card} onDone={reload} onFail={fail} onMessage={report} />
              </>
            )}
          </Block>
        </Panel>

        <Panel title={ru.users.card.payments} anchor="payments">
          <Block state={state} onReload={reload} empty={ru.users.card.noPayments} isEmpty={(card) => card.payments.length === 0}>
            {(card) => (
              <table>
                <thead>
                  <tr>
                    <th>{ru.users.card.payCharge}</th>
                    <th>{ru.users.card.payKind}</th>
                    <th className="num">{ru.users.card.payStars}</th>
                    <th>{ru.users.card.payAt}</th>
                  </tr>
                </thead>
                <tbody>
                  {card.payments.map((payment) => (
                    <tr key={payment.id}>
                      <td className="mono">{payment.charge_id}</td>
                      <td>
                        {payment.kind === 'payment' ? ru.users.card.kindPayment : ru.users.card.kindRefund}
                        {payment.refunded ? ` · ${ru.users.card.refunded}` : ''}
                      </td>
                      <td className="num">{formatStars(payment.stars)}</td>
                      <td className="muted">{formatDateTime(payment.at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Block>
          {state.kind === 'ok' ? (
            <UserRefundRow api={api} card={state.data} onDone={reload} onFail={fail} onMessage={report} />
          ) : null}
        </Panel>
      </div>
    </>
  );
}

/** Пуш — единственное обратимое действие: одно нажатие, двух шагов не требует. */
function UserPushRow({
  api,
  card,
  onDone,
  onFail,
  onMessage,
}: {
  api: AdminApi;
  card: AdminUserCard;
  onDone: () => void;
  onFail: (error: unknown) => { level: 'warn' | 'crit'; text: string };
  onMessage: (next: { level: 'ok' | 'warn' | 'crit'; text: string }) => void;
}) {
  const [busy, setBusy] = useState(false);
  const toggle = useCallback(async () => {
    setBusy(true);
    try {
      await api.userPush(card.user_id, { enabled: !card.push_enabled });
      onMessage({ level: 'ok', text: `${ru.users.card.pushNote}: ${card.push_enabled ? ru.users.card.pushOn : ru.users.card.pushOff}` });
      onDone();
    } catch (error) {
      onMessage(onFail(error));
    } finally {
      setBusy(false);
    }
  }, [api, card.push_enabled, card.user_id, onDone, onFail, onMessage]);

  return (
    <div className="row" style={{ marginTop: 8 }}>
      <button type="button" onClick={() => { void toggle(); }} disabled={busy}>
        {card.push_enabled ? ru.users.card.pushOn : ru.users.card.pushOff}
      </button>
      <span className="muted">{ru.users.card.pushNote}</span>
    </div>
  );
}

function UserBanRow({
  api,
  card,
  onDone,
  onFail,
  onMessage,
}: {
  api: AdminApi;
  card: AdminUserCard;
  onDone: () => void;
  onFail: (error: unknown) => { level: 'warn' | 'crit'; text: string };
  onMessage: (next: { level: 'ok' | 'warn' | 'crit'; text: string }) => void;
}) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const banned = card.banned_at !== null;
  const valid = reason.trim() !== '';

  const run = useCallback(async () => {
    if (!valid || busy) return;
    setBusy(true);
    try {
      const result = await api.userBan(card.user_id, { reason: reason.trim() });
      onMessage({
        level: 'ok',
        text: `${ru.users.card.banDone}: ${result.data.banned ? ru.users.banned : ru.users.live} · ${result.data.reason}`,
      });
      onDone();
    } catch (error) {
      onMessage(onFail(error));
    } finally {
      setBusy(false);
    }
  }, [api, busy, card.user_id, onDone, onFail, onMessage, reason, valid]);

  return (
    <div className="flow" style={{ marginTop: 8 }}>
      <label className="field">
        {ru.users.card.banReason}
        <textarea rows={2} maxLength={500} value={reason} onChange={(event) => { setReason(event.target.value); }} />
      </label>
      {!valid ? <span className="muted">{ru.users.card.banNeedsReason}</span> : null}
      <HoldConfirm
        label={banned ? ru.users.card.unban : ru.users.card.ban}
        busy={busy}
        disabled={!valid}
        onExecute={() => { void run(); }}
      >
        <p className="confirm__delta">
          {banned ? ru.users.card.unban : ru.users.card.ban} · {card.tg_id} · {reason.trim() === '' ? ru.users.card.banNeedsReason : reason.trim()}
        </p>
      </HoldConfirm>
    </div>
  );
}

/**
 * Возврат звёзд: только полный. Сумма — серверная (`card.refundable`), поле
 * ввода одно и оно же — подтверждение: человек повторяет серверно число.
 */
function UserRefundRow({
  api,
  card,
  onDone,
  onFail,
  onMessage,
}: {
  api: AdminApi;
  card: AdminUserCard;
  onDone: () => void;
  onFail: (error: unknown) => { level: 'warn' | 'crit'; text: string };
  onMessage: (next: { level: 'ok' | 'warn' | 'crit'; text: string }) => void;
}) {
  const [reason, setReason] = useState('');
  const [echo, setEcho] = useState('');
  const [busy, setBusy] = useState(false);
  const quote = card.refundable;

  const valid = quote !== null && reason.trim() !== '' && echoMatches(echo, quote.amount_stars);

  const run = useCallback(async () => {
    if (!valid || busy) return;
    setBusy(true);
    try {
      const result = await api.userRefund(card.user_id, { reason: reason.trim() });
      onMessage({
        level: 'ok',
        text: `${ru.users.card.refundDone}: ${formatStars(result.data.amount_stars)} · ${ru.users.card.refundStatus} ${result.data.status} · ${result.data.charge_id}`,
      });
      onDone();
    } catch (error) {
      onMessage(onFail(error));
    } finally {
      setBusy(false);
    }
  }, [api, busy, card.user_id, onDone, onFail, onMessage, reason, valid]);

  if (quote === null) return <Notice>{ru.users.card.refundNothing}</Notice>;

  return (
    <div className="flow" style={{ marginTop: 8 }}>
      <Notice>{ru.users.card.refundLead}</Notice>
      <KeyValue
        rows={[
          { label: ru.users.card.refundAmount, value: formatStars(quote.amount_stars) },
          { label: ru.users.card.payCharge, value: <span className="mono">{quote.charge_id}</span> },
        ]}
      />
      <label className="field">
        {ru.users.card.refundReason}
        <textarea rows={2} maxLength={500} value={reason} onChange={(event) => { setReason(event.target.value); }} />
      </label>
      <label className="field">
        {ru.users.card.refundEcho} ({quote.amount_stars})
        <input
          type="text"
          inputMode="numeric"
          value={echo}
          onChange={(event) => { setEcho(event.target.value); }}
          aria-invalid={echo !== '' && !echoMatches(echo, quote.amount_stars)}
        />
      </label>
      {echo !== '' && !echoMatches(echo, quote.amount_stars) ? (
        <span className="muted">{ru.users.card.refundEchoMismatch}</span>
      ) : null}
      <HoldConfirm label={ru.users.card.refund} busy={busy} disabled={!valid} onExecute={() => { void run(); }}>
        <p className="confirm__delta">
          {ru.users.card.refundAmount}: {formatStars(quote.amount_stars)} · {reason.trim() === '' ? ru.users.card.refundReason : reason.trim()}
        </p>
      </HoldConfirm>
    </div>
  );
}
