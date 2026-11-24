/*
 * Экран «Пользователи» (ТЗ §4.2): поиск ровно одним параметром, карточка
 * человека и три действия — проверочный пуш, блокировка с основанием и возврат
 * звёзд. Маршруты `/admin/users*` пришли в контракт в 1.6.16, поэтому экран
 * работает и в проде, и в ДЕМО на одних и тех же полях.
 *
 * Запреты, которые держит этот файл:
 *   • поиск отправляется одним параметром — `telegram_id`, `alias` или `q`;
 *     два сразу сервер не принимает, и панель этот ответ сама не создаёт;
 *   • у возврата НЕТ поля «сколько вернуть»: возврат только полный, сумму
 *     считает сервер, экран её показывает и просит повторить как подтверждение;
 *   • блокировка и разбан — один маршрут (`banned: true|false`), без основания
 *     не отправляются;
 *   • в карточке нет ничего, чего не вернул сервер: ни «примерной» суммы, ни
 *     «вероятного» тарифа, ни статуса блокировки бота.
 */

import { useCallback, useState } from 'react';
import type { AdminApi } from '../api/admin';
import { ApiError } from '../api/errors';
import type { AdminPayment, AdminUserCard, AdminUserSummary } from '../api/types';
import { Block } from '../ui/Block';
import { RouteGaps } from '../ui/RouteGaps';
import { HoldConfirm } from '../ui/HoldConfirm';
import { Banner, EmptyRow, KeyValue, Notice, Panel, Pill } from '../ui/primitives';
import { useResource } from '../hooks/useResource';
import { ru } from '../i18n/ru';
import { EMPTY, formatDateTime, formatInt, formatRub, formatStars } from '../lib/format';
import { buildUsersSearch, echoMatches, refundablePayments, type SearchMode } from '../lib/plansUsers';

export interface UsersProps {
  readonly api: AdminApi;
  readonly sessionLive: boolean;
  readonly demo: boolean;
}

export function Users({ api, sessionLive, demo }: UsersProps) {
  const [mode, setMode] = useState<SearchMode>('telegram_id');
  const [raw, setRaw] = useState('');
  const [submitted, setSubmitted] = useState<{ mode: SearchMode; raw: string } | null>(null);
  const [selected, setSelected] = useState<AdminUserSummary | null>(null);

  const build = buildUsersSearch(mode, raw);

  const load = useCallback(
    async (signal: AbortSignal) => {
      const request = buildUsersSearch(submitted?.mode ?? 'q', submitted?.raw ?? '');
      if (!request.ok) throw new Error('поиск отправлен без значения');
      const result = await api.usersSearch(request.params, signal);
      return { data: result.data, demo: result.demo, requestId: result.requestId };
    },
    [api, submitted],
  );
  const { state, reload } = useResource<{ items: readonly AdminUserSummary[]; truncated: boolean }>(load, {
    routeKey: 'usersSearch',
    enabled: submitted !== null && sessionLive,
    allowMissing: demo,
  });

  const openCard = useCallback((row: AdminUserSummary) => { setSelected(row); }, []);
  const back = useCallback(() => { setSelected(null); }, []);

  if (selected !== null) {
    return <UserCardView api={api} sessionLive={sessionLive} demo={demo} row={selected} onBack={back} />;
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
            <Block state={state} onReload={reload} empty={ru.users.resultsEmpty} isEmpty={(page) => page.items.length === 0}>
              {(page) => (
                <>
                  {page.truncated ? <p className="muted">{ru.users.truncated}</p> : null}
                  <table>
                    <thead>
                      <tr>
                        <th>{ru.users.colPerson}</th>
                        <th>{ru.users.colAccess}</th>
                        <th>{ru.users.colState}</th>
                        <th>{ru.users.colSeen}</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {page.items.length === 0 ? <EmptyRow colSpan={5} text={ru.users.resultsEmpty} /> : null}
                      {page.items.map((row) => (
                        <tr key={row.user_id}>
                          {/* Ни `telegram_id`, ни имени в ответе списка нет намеренно (без ПДн) —
                              только псевдоним, который сервер выдал сам. */}
                          <td className="mono">{row.alias === '' ? EMPTY : row.alias}</td>
                          <td>
                            {row.subscription_plan ?? EMPTY}
                            <div className="muted">
                              {row.subscription_expires_at === null || row.subscription_expires_at === undefined
                                ? EMPTY
                                : formatDateTime(row.subscription_expires_at)}
                            </div>
                          </td>
                          <td>
                            {row.banned ? (
                              <Pill tone="crit">{ru.users.banned}</Pill>
                            ) : row.has_subscription ? (
                              <Pill tone="ok">{ru.users.live}</Pill>
                            ) : (
                              <Pill tone="muted">{ru.users.noAccess}</Pill>
                            )}
                          </td>
                          <td className="muted">
                            {row.last_seen_at === null || row.last_seen_at === undefined ? EMPTY : formatDateTime(row.last_seen_at)}
                          </td>
                          <td>
                            <button type="button" onClick={() => { openCard(row); }}>{ru.users.open}</button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <p className="muted">{ru.users.noTgInList}</p>
                </>
              )}
            </Block>
          )}
        </Panel>
        <RouteGaps screen="users" anchor="gaps" />
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
  row: AdminUserSummary;
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
  /**
   * Отказ действия показан текстом сервера: `message` дословно, `reason` —
   * кодом, `details.field_errors` — по полям. Панель ничего не переформулирует:
   * «что сказал сервер» и «что увидел админ» обязаны совпадать.
   */
  const fail = useCallback((error: unknown): { level: 'warn' | 'crit'; text: string } => {
    if (error instanceof ApiError) {
      const fields = error.fieldErrors.map((item) => `${item.field}: ${item.message}`).join(' · ');
      const detail =
        `${error.message}${error.reason ? ` (${error.reason})` : ''}` +
        `${fields === '' ? '' : ` · ${fields}`}${error.requestId ? ` · request_id ${error.requestId}` : ''}`;
      return { level: error.isMissingRoute ? 'warn' : 'crit', text: detail };
    }
    return { level: 'crit', text: String(error) };
  }, []);

  return (
    <>
      <h1>{ru.users.card.title}</h1>
      <div className="row" style={{ marginBottom: 8 }}>
        <button type="button" onClick={onBack}>{ru.users.card.back}</button>
        <span className="muted mono">{row.alias === '' ? EMPTY : row.alias}</span>
      </div>
      {message ? <Banner level={message.level} title={message.text} /> : null}
      <div className="grid">
        <Panel title={ru.users.card.profile} anchor="profile" onReload={reload}>
          <Block state={state} onReload={reload}>
            {(card) => (
              <>
                <KeyValue
                  rows={[
                    { label: ru.users.colPerson, value: <span className="mono">{card.alias === '' ? EMPTY : card.alias}</span> },
                    {
                      label: ru.users.card.tgId,
                      // `telegram_id` — опциональное поле карточки: сервер может
                      // не вернуть его вовсе, и это «не знаем», а не «0».
                      value: card.telegram_id === null || card.telegram_id === undefined ? ru.users.card.noTgId : <span className="mono">{card.telegram_id}</span>,
                    },
                    { label: ru.users.card.created, value: formatDateTime(card.created_at) },
                    {
                      label: ru.users.card.lastSeen,
                      value: card.last_seen_at === null || card.last_seen_at === undefined ? EMPTY : formatDateTime(card.last_seen_at),
                    },
                    {
                      label: ru.users.card.access,
                      value:
                        card.subscription === undefined || card.subscription === null || !card.subscription.is_active
                          ? ru.users.card.noAccessLine
                          : (
                            <>
                              {card.subscription.plan} · {ru.users.card.accessUntil}{' '}
                              {card.subscription.expires_at === null || card.subscription.expires_at === undefined
                                ? EMPTY
                                : formatDateTime(card.subscription.expires_at)}{' '}
                              · {ru.users.card.accessAutoRenew}: {card.subscription.auto_renew ? 'да' : 'нет'} ·{' '}
                              {ru.users.card.accessStarsPaid} {formatInt(card.subscription.stars_paid_total)}
                            </>
                          ),
                    },
                    ...(card.banned
                      ? [
                          { label: ru.users.card.bannedAt, value: formatDateTime(card.banned_at) },
                          { label: ru.users.card.bannedReason, value: card.ban_reason ?? EMPTY },
                        ]
                      : []),
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
                    <th>{ru.users.card.payPlan}</th>
                    <th>{ru.users.card.payStatus}</th>
                    <th className="num">{ru.users.card.payStars}</th>
                    <th>{ru.users.card.payAt}</th>
                    <th>{ru.users.card.payRefundedAt}</th>
                  </tr>
                </thead>
                <tbody>
                  {card.payments.map((payment) => (
                    <tr key={payment.charge_id}>
                      <td className="mono">{payment.charge_id}</td>
                      <td className="mono">{payment.plan_code}</td>
                      <td>
                        {paymentStatusLabel(payment.status)}
                        {payment.is_test ? ` · ${ru.users.card.payTest}` : ''}
                      </td>
                      <td className="num">{formatStars(payment.amount_stars)}</td>
                      <td className="muted">{formatDateTime(payment.paid_at)}</td>
                      {/* Возврата не было — это «—», а не «вернул 0 ⭐». */}
                      <td className="muted">
                        {payment.refunded_at === null || payment.refunded_at === undefined ? EMPTY : formatDateTime(payment.refunded_at)}
                      </td>
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

        <Panel title={ru.users.card.chart} anchor="chart">
          <Block state={state} onReload={reload} empty={ru.users.card.noChart} isEmpty={(card) => card.chart === undefined || card.chart === null}>
            {(card) =>
              card.chart === undefined || card.chart === null ? null : (
                <KeyValue
                  rows={[
                    { label: ru.users.card.chartId, value: <span className="mono">{card.chart.chart_id}</span> },
                    {
                      label: ru.users.card.chartTimeKnown,
                      value: card.chart.time_known ? ru.users.card.chartTimeKnownYes : ru.users.card.chartTimeKnownNo,
                    },
                    { label: ru.users.card.chartEngine, value: <span className="mono">{card.chart.engine_version}</span> },
                    { label: ru.users.card.chartBuilt, value: formatDateTime(card.chart.created_at) },
                  ]}
                />
              )
            }
          </Block>
        </Panel>

        <Panel title={ru.users.card.grants} anchor="grants">
          <Block state={state} onReload={reload} empty={ru.users.card.grantsEmpty} isEmpty={(card) => card.grants.length === 0}>
            {(card) => (
              <table>
                <thead>
                  <tr>
                    <th>{ru.users.card.grantKind}</th>
                    <th>{ru.users.card.grantSource}</th>
                    <th className="num">{ru.users.card.grantDays}</th>
                    <th>{ru.users.card.grantExpires}</th>
                    <th>{ru.users.card.grantConsumed}</th>
                    <th>{ru.users.card.grantRevoked}</th>
                  </tr>
                </thead>
                <tbody>
                  {card.grants.map((grant, index) => (
                    <tr key={`${grant.id}-${index}`}>
                      <td className="mono">{grant.kind}</td>
                      <td className="mono">{grant.source}</td>
                      <td className="num">{grant.days === null || grant.days === undefined ? EMPTY : formatInt(grant.days)}</td>
                      <td className="muted">{formatDateTime(grant.expires_at)}</td>
                      <td className="muted">{formatDateTime(grant.consumed_at)}</td>
                      <td className="muted">{formatDateTime(grant.revoked_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Block>
        </Panel>

        <Panel title={ru.users.card.counts} anchor="counts">
          <Block state={state} onReload={reload}>
            {(card) => (
              <KeyValue
                rows={[
                  { label: ru.users.card.countReports, value: formatInt(card.counts.reports) },
                  { label: ru.users.card.countCompat, value: formatInt(card.counts.compatibility) },
                  { label: ru.users.card.countQuestions, value: formatInt(card.counts.questions) },
                  { label: ru.users.card.countForecasts, value: formatInt(card.counts.forecasts) },
                  { label: ru.users.card.cost, value: formatRub(card.cost_rub) },
                ]}
              />
            )}
          </Block>
        </Panel>
      </div>
    </>
  );
}

/**
 * Проверочный пуш. Отдельного маршрута «включить/выключить пуши человека» в
 * контракте нет — флагом `push_enabled` управляет сам человек в мини-аппе, а
 * панель умеет только попросить Telegram отправить утреннее сообщение сейчас.
 */
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

  /**
   * `409 push_disabled` — это и есть «человек заблокировал бота»: сервер
   * сообщает об этом причиной отказа, отдельного поля статуса в контракте нет.
   */
  const describe = useCallback(
    (error: unknown): { level: 'warn' | 'crit'; text: string } => {
      const base = onFail(error);
      if (error instanceof ApiError && (error.reason === 'push_disabled' || error.reason === 'push_test_sent_24h')) {
        return { level: 'warn', text: `${base.text} · ${error.reason === 'push_disabled' ? ru.users.card.pushBlocked : ru.users.card.pushOncePerDay}` };
      }
      return base;
    },
    [onFail],
  );

  const send = useCallback(async () => {
    setBusy(true);
    try {
      const result = await api.userPush(card.user_id);
      // `sent` в ответе — `const true`: 200 всегда значит «ушло».
      onMessage({
        level: 'ok',
        text: `${ru.users.card.pushSent} · ${formatDateTime(result.data.sent_at)} · ${result.data.kind}`,
      });
      onDone();
    } catch (error) {
      onMessage(describe(error));
    } finally {
      setBusy(false);
    }
  }, [api, card.user_id, describe, onDone, onMessage]);

  return (
    <div className="flow" style={{ marginTop: 8 }}>
      <div className="row" style={{ gap: 8 }}>
        <button type="button" disabled={busy} onClick={() => { void send(); }}>
          {busy ? ru.users.card.pushBusy : ru.users.card.pushTest}
        </button>
        <Pill tone={card.push_enabled ? 'ok' : 'muted'}>
          {ru.users.card.pushEnabledFlag}: {card.push_enabled ? 'да' : 'нет'}
        </Pill>
      </div>
      <p className="muted">{ru.users.card.pushNote}</p>
      <p className="muted">{ru.users.card.pushStatusNote}</p>
    </div>
  );
}

/** Бан и разбан — один маршрут; `reason` обязателен, потому что уходит в аудит. */
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
  const canSend = reason.trim() !== '' && !busy;

  const apply = useCallback(async () => {
    if (!canSend) return;
    setBusy(true);
    try {
      const result = await api.userBan(card.user_id, { banned: !card.banned, reason: reason.trim() });
      const state = result.data.banned
        ? `${ru.users.banned}: ${formatDateTime(result.data.banned_at)}`
        : ru.users.card.unbanDone;
      onMessage({ level: 'ok', text: `${ru.users.card.banDone} · ${state} · ${result.data.reason ?? EMPTY}` });
      onDone();
    } catch (error) {
      onMessage(onFail(error));
    } finally {
      setBusy(false);
    }
  }, [api, canSend, card.banned, card.user_id, onDone, onFail, onMessage, reason]);

  return (
    <div className="flow" style={{ marginTop: 8 }}>
      <p className="muted">{ru.users.card.banLead}</p>
      <label className="field">
        {ru.users.card.banReason}
        <textarea
          rows={2}
          maxLength={500}
          value={reason}
          onChange={(event) => { setReason(event.target.value); }}
        />
      </label>
      {reason.trim() === '' ? <p className="muted">{ru.users.card.banNeedsReason}</p> : null}
      <HoldConfirm
        label={card.banned ? ru.users.card.unban : ru.users.card.ban}
        busy={busy}
        disabled={!canSend}
        onExecute={() => { void apply(); }}
      >
        <p className="confirm__delta">
          {card.banned ? ru.users.card.unban : ru.users.card.ban} · {card.alias} — {reason.trim() === '' ? ru.users.card.banNeedsReason : reason.trim()}
        </p>
      </HoldConfirm>
    </div>
  );
}

/**
 * Возврат звёзд. Единственный аргумент, который выбирает админ, — платёж
 * (`charge_id`); сумма берётся из `payments[].amount_stars` только для показа
 * и для эха, а в тело запроса не попадает: сервер считает её сам.
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
  const charges: readonly AdminPayment[] = refundablePayments(card.payments);
  const [chargeId, setChargeId] = useState<string>(charges[0]?.charge_id ?? '');
  const [reason, setReason] = useState('');
  const [echo, setEcho] = useState('');
  const [busy, setBusy] = useState(false);

  const charge = charges.find((item) => item.charge_id === chargeId) ?? null;
  const canSend = charge !== null && reason.trim() !== '' && echoMatches(echo, charge.amount_stars) && !busy;

  // Без `useCallback`: мемоизация здесь ничего не бережёт (функция живёт в
  // одной строке таблицы), а зависимости-объекты только мешают компилятору.
  const send = async (): Promise<void> => {
    if (charge === null || !canSend) return;
    setBusy(true);
    try {
      const result = await api.userRefund(card.user_id, { charge_id: charge.charge_id, reason: reason.trim() });
      // `access_revoked` в контракте — константный `false`: возврат звёзд доступ
      // не отзывает (отзывает его `ban`). Ветки «сервер закрыл доступ» здесь нет
      // намеренно — она была бы недостижимым обещанием.
      const access = ru.users.card.refundAccessKept;
      onMessage({
        level: 'ok',
        text: `${ru.users.card.refundDone} · ${formatStars(result.data.amount_stars)} ⭐ · ${formatDateTime(result.data.refunded_at)} · ${access}`,
      });
      onDone();
    } catch (error) {
      onMessage(onFail(error));
    } finally {
      setBusy(false);
    }
  };

  if (charges.length === 0) {
    return <Notice>{ru.users.card.refundNothing}</Notice>;
  }

  return (
    <div className="flow" style={{ marginTop: 8 }}>
      <Notice>{ru.users.card.refundLead}</Notice>
      <label className="field">
        {ru.users.card.refundPick}
        <select value={chargeId} onChange={(event) => { setChargeId(event.target.value); }}>
          {charges.map((item) => (
            <option key={item.charge_id} value={item.charge_id}>
              {item.charge_id} · {formatInt(item.amount_stars)} ⭐ · {item.plan_code}
            </option>
          ))}
        </select>
      </label>
      {/* Поля «сколько вернуть» здесь нет намеренно: частичного возврата
          платёжный слой не умеет, а значит и ввести такую сумму нельзя. */}
      <p className="muted">
        {ru.users.card.refundAmount}: {charge === null ? EMPTY : formatStars(charge.amount_stars)}
      </p>
      <label className="field">
        {ru.users.card.refundReason}
        <textarea
          rows={2}
          maxLength={500}
          value={reason}
          onChange={(event) => { setReason(event.target.value); }}
        />
      </label>
      <HoldConfirm
        label={busy ? ru.users.card.refundBusy : ru.users.card.refund}
        busy={busy}
        disabled={!canSend}
        onExecute={() => { void send(); }}
      >
        <p className="confirm__delta">
          {ru.users.card.refundAmount}: {charge === null ? EMPTY : formatStars(charge.amount_stars)} — {ru.confirm.typedPlaceholder}
        </p>
        <label className="field">
          {ru.users.card.refundEcho}
          <input
            type="text"
            inputMode="numeric"
            value={echo}
            onChange={(event) => { setEcho(event.target.value); }}
            aria-invalid={echo !== '' && (charge === null || !echoMatches(echo, charge.amount_stars))}
          />
        </label>
        {echo !== '' && (charge === null || !echoMatches(echo, charge.amount_stars)) ? (
          <p className="muted">{ru.users.card.refundEchoMismatch}</p>
        ) : null}
      </HoldConfirm>
    </div>
  );
}

/** Статус заряда — текстом контракта, без «догадок» про то, что он значит. */
function paymentStatusLabel(status: AdminPayment['status']): string {
  switch (status) {
    case 'paid':
      return ru.users.card.statusPaid;
    case 'processed':
      return ru.users.card.statusProcessed;
    case 'refunded':
      return ru.users.card.statusRefunded;
    case 'failed':
      return ru.users.card.statusFailed;
  }
}
