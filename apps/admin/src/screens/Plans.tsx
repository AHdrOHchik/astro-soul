/*
 * Экран «Тарифы» (ТЗ §4.3): цены в звёздах, обязательное основание правки и
 * история «кто и когда менял». Маршрутов `/admin/plans*` в контракте 1.6.14
 * нет, поэтому в проде каждый блок экрана честно говорит «недоступно» и
 * перечисляет, чего ждёт от бэкенда; работает экран в ДЕМО-режиме на dev-мокере.
 *
 * Запреты, которые держит этот файл:
 *   • цена не пересчитывается и не «округляется» на клиенте — в `PATCH`
 *     уходит ровно то число, которое напечатано в форме и повторено на
 *     втором шаге;
 *   • правка без `comment` не отправляется (ответ владельца, §4);
 *   • `founder_month` не редактируется: флаг `founder_only` приходит с
 *     сервера, свой список кодов панель не ведёт (§5);
 *   • `409 price_changed` не перезаписывает чужую правку — экран перечитывает
 *     каталог и показывает текущее значение.
 */

import { useCallback, useState } from 'react';
import type { AdminApi } from '../api/admin';
import { ApiError } from '../api/errors';
import type { AdminPlanHistoryRow, AdminPlanRow } from '../api/types';
import { Block } from '../ui/Block';
import { HoldConfirm } from '../ui/HoldConfirm';
import { Banner, EmptyRow, Notice, Panel, Pill } from '../ui/primitives';
import { useResource } from '../hooks/useResource';
import { ru } from '../i18n/ru';
import { EMPTY, formatAgo, formatDateTime, formatInt } from '../lib/format';
import { checkPriceForm, echoMatches, planEditLocked, type PriceForm } from '../lib/plansUsers';

export interface PlansProps {
  readonly api: AdminApi;
  readonly sessionLive: boolean;
  readonly demo: boolean;
  readonly now: number;
}

export function Plans({ api, sessionLive, demo, now }: PlansProps) {
  const [editing, setEditing] = useState<AdminPlanRow | null>(null);
  const [historyCode, setHistoryCode] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ level: 'ok' | 'warn' | 'crit'; text: string } | null>(null);

  const load = useCallback(
    async (signal: AbortSignal) => {
      const result = await api.plans(signal);
      return { data: result.data.items, demo: result.demo, requestId: result.requestId };
    },
    [api],
  );
  const { state, reload } = useResource<readonly AdminPlanRow[]>(load, {
    routeKey: 'plansList',
    enabled: sessionLive,
    allowMissing: demo,
  });

  // Кнопка «редактировать» держит в руках актуальную строку каталога: форма
  // правки стартует от серверного `version`, а не от той, что была открыта.
  const current = editing === null ? null : state.kind === 'ok' ? state.data.find((item) => item.code === editing.code) ?? editing : editing;

  const afterSave = useCallback(
    (next: { level: 'ok' | 'warn' | 'crit'; text: string }) => {
      setNotice(next);
      setEditing(null);
      reload();
    },
    [reload],
  );

  return (
    <>
      <h1>{ru.plans.heading}</h1>
      <p className="lead">{ru.plans.lead}</p>
      {notice ? <Banner level={notice.level} title={notice.text} /> : null}
      <div className="grid">
        <Panel title={ru.plans.catalog} anchor="plans" onReload={reload} busy={state.kind === 'loading'}>
          {!sessionLive ? (
            <Banner level="warn" title={ru.states.unauthorized}>{ru.overview.publicOnly}</Banner>
          ) : (
            <Block state={state} onReload={reload} empty={ru.plans.catalogEmpty} isEmpty={(items) => items.length === 0}>
              {(items) => (
                <table>
                  <thead>
                    <tr>
                      <th>{ru.plans.plan}</th>
                      <th className="num">{ru.plans.price}</th>
                      <th className="num">{ru.plans.discount}</th>
                      <th>{ru.plans.flags}</th>
                      <th>{ru.plans.updated}</th>
                      <th>{ru.plans.updatedBy}</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {items.length === 0 ? <EmptyRow colSpan={7} text={ru.plans.catalogEmpty} /> : null}
                    {items.map((plan) => {
                      const locked = planEditLocked(plan);
                      return (
                        <tr key={plan.code}>
                          <td>
                            {plan.title}
                            <div className="muted mono">{plan.code}</div>
                          </td>
                          <td className="num">{formatInt(plan.price_stars)}</td>
                          <td className="num">{plan.discount_price_stars === null ? EMPTY : formatInt(plan.discount_price_stars)}</td>
                          <td>
                            <Pill tone={plan.is_active ? 'ok' : 'muted'}>{plan.is_active ? ru.plans.active : ru.plans.inactive}</Pill>{' '}
                            {plan.test_only ? <Pill tone="warn">{ru.plans.test}</Pill> : null}{' '}
                            {plan.founder_only ? <Pill tone="warn">{ru.plans.founder}</Pill> : null}
                          </td>
                          <td className="muted">{formatAgo(plan.updated_at, now)}</td>
                          <td>
                            {plan.updated_by_name ?? EMPTY}{' '}
                            {plan.updated_by_tg_id !== null ? <span className="muted mono">{plan.updated_by_tg_id}</span> : null}
                          </td>
                          <td className="row" style={{ gap: 6 }}>
                            <button type="button" disabled={locked} title={locked ? ru.plans.founderLocked : undefined} onClick={() => { setEditing(plan); setNotice(null); }}>
                              {ru.plans.edit}
                            </button>
                            <button type="button" onClick={() => { setHistoryCode(historyCode === plan.code ? null : plan.code); }}>
                              {historyCode === plan.code ? ru.plans.historyClose : ru.plans.historyOpen}
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </Block>
          )}
        </Panel>

        {current !== null ? (
          <PlanEditPanel
            key={`${current.code}-${current.version}`}
            api={api}
            plan={current}
            onClose={() => { setEditing(null); }}
            onDone={afterSave}
          />
        ) : null}

        {historyCode !== null ? <PlanHistoryPanel api={api} code={historyCode} sessionLive={sessionLive} demo={demo} /> : null}
      </div>
    </>
  );
}

/**
 * Форма правки цены. Два шага решает `HoldConfirm`, повтор значения — поле
 * эха: кнопка «Подтвердить ещё раз» не становится доступной, пока набранное
 * не совпало с новой ценой. Отправка — одна, без ретраев (PATCH не идемпотентен).
 */
function PlanEditPanel({
  api,
  plan,
  onClose,
  onDone,
}: {
  api: AdminApi;
  plan: AdminPlanRow;
  onClose: () => void;
  onDone: (notice: { level: 'ok' | 'warn' | 'crit'; text: string }) => void;
}) {
  const [form, setForm] = useState<PriceForm>({
    price: String(plan.price_stars),
    discount: plan.discount_price_stars === null ? '' : String(plan.discount_price_stars),
    comment: '',
  });
  const [echo, setEcho] = useState('');
  const [busy, setBusy] = useState(false);

  const check = checkPriceForm(form, plan);
  // Формулировку «кого касается» задаёт сервер кодом; панель знает единственный
  // ответ и честно говорит «правило не названо», если приходит что-то другое.
  const scopeText =
    plan.price_change_scope === 'only_new_purchases' ? ru.plans.scopes.only_new_purchases : ru.plans.scopeUnknown;

  const submit = useCallback(async () => {
    if (!check.valid || !echoMatches(echo, check.priceStars) || busy) return;
    setBusy(true);
    try {
      const result = await api.plansPatch(plan.code, {
        price_stars: check.priceStars,
        discount_price_stars: check.discountStars,
        comment: form.comment.trim(),
        base_version: plan.version,
      });
      onDone({
        level: 'ok',
        text: `${ru.plans.done}: ${plan.title} · ${formatInt(result.data.plan.price_stars)} ⭐ · ${ru.plans.auditLine}: ${result.data.audit.actor_name} @ ${formatDateTime(result.data.audit.at)}`,
      });
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        onDone({ level: 'warn', text: `${ru.plans.conflict} (${error.code})` });
      } else {
        const text = error instanceof ApiError ? `${error.message}${error.reason ? ` (${error.reason})` : ''}` : String(error);
        onDone({ level: 'crit', text });
      }
    } finally {
      setBusy(false);
    }
  }, [api, busy, check, echo, form.comment, onDone, plan]);

  return (
    <Panel title={`${ru.plans.form.title} · ${plan.title}`} anchor="edit">
      <Notice>{ru.plans.form.lead}</Notice>
      <Banner level="info" title={ru.plans.form.versionLead} />
      <form
        className="flow"
        onSubmit={(event) => {
          event.preventDefault();
        }}
      >
        <div className="row">
          <label className="field">
            {ru.plans.form.price}
            <input
              type="text"
              inputMode="numeric"
              value={form.price}
              onChange={(event) => { setForm({ ...form, price: event.target.value }); }}
              aria-invalid={form.price.trim() !== '' && !/^\d+$/.test(form.price.trim())}
            />
          </label>
          <label className="field">
            {ru.plans.form.discount}
            <input
              type="text"
              inputMode="numeric"
              value={form.discount}
              onChange={(event) => { setForm({ ...form, discount: event.target.value }); }}
            />
          </label>
        </div>
        <label className="field">
          {ru.plans.form.comment}
          <textarea
            rows={2}
            maxLength={500}
            placeholder={ru.plans.form.commentPlaceholder}
            value={form.comment}
            onChange={(event) => { setForm({ ...form, comment: event.target.value }); }}
          />
        </label>
        <p className="muted">
          {ru.confirm.typePriceHint}: {formatInt(plan.price_stars)} ⭐ → {formatInt(check.priceStars)} ⭐ · {scopeText}
        </p>
        <HoldConfirm
          label={busy ? ru.plans.form.submitting : ru.plans.form.submit}
          busy={busy}
          disabled={!check.valid || !echoMatches(echo, check.priceStars)}
          onExecute={() => { void submit(); }}
        >
          <p className="confirm__delta">
            {ru.confirm.newPrice}: {form.price.trim()} ⭐ — {ru.confirm.typedPlaceholder}
          </p>
          <label className="field">
            {ru.plans.form.echo}
            <input
              type="text"
              inputMode="numeric"
              value={echo}
              onChange={(event) => { setEcho(event.target.value); }}
              aria-invalid={echo !== '' && !echoMatches(echo, check.priceStars)}
            />
          </label>
          {echo !== '' && !echoMatches(echo, check.priceStars) ? (
            <p className="muted">{ru.confirm.typedMismatch}</p>
          ) : null}
        </HoldConfirm>
        <div className="row">
          <button type="button" onClick={onClose} disabled={busy}>
            {ru.plans.form.cancel}
          </button>
        </div>
      </form>
    </Panel>
  );
}

function PlanHistoryPanel({ api, code, sessionLive, demo }: { api: AdminApi; code: string; sessionLive: boolean; demo: boolean }) {
  const load = useCallback(
    async (signal: AbortSignal) => {
      const result = await api.plansHistory(code, signal);
      return { data: result.data.items, demo: result.demo, requestId: result.requestId };
    },
    [api, code],
  );
  const { state, reload } = useResource<readonly AdminPlanHistoryRow[]>(load, {
    routeKey: 'plansAudit',
    enabled: sessionLive,
    allowMissing: demo,
  });

  return (
    <Panel title={`${ru.plans.historyTitle} · ${code}`} anchor="history" onReload={reload}>
      <Block state={state} onReload={reload} empty={ru.plans.historyEmpty} isEmpty={(items) => items.length === 0}>
        {(items) => (
          <table>
            <thead>
              <tr>
                <th>{ru.plans.historyWhen}</th>
                <th>{ru.plans.historyWho}</th>
                <th className="num">{ru.plans.historyFrom}</th>
                <th className="num">{ru.plans.historyTo}</th>
                <th>{ru.plans.historyComment}</th>
              </tr>
            </thead>
            <tbody>
              {items.length === 0 ? <EmptyRow colSpan={5} text={ru.plans.historyEmpty} /> : null}
              {items.map((row, index) => (
                <tr key={`${row.at}-${index}`}>
                  <td>{formatDateTime(row.at)}</td>
                  <td>
                    {row.actor_name} <span className="muted mono">{row.actor_tg_id}</span>
                  </td>
                  <td className="num">{row.from_price === null ? EMPTY : formatInt(row.from_price)}</td>
                  <td className="num">{formatInt(row.to_price)}</td>
                  <td>{row.comment}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Block>
    </Panel>
  );
}
