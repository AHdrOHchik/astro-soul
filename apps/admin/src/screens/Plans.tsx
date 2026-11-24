/*
 * Экран «Тарифы» (ТЗ §4.3): цены в звёздах, флаг «только для теста»,
 * обязательное основание правки и история «кто и когда менял». С 1.6.16 все три
 * маршрута (`/admin/plans`, `PATCH /admin/plans/{code}`, `.../history`) есть в
 * контракте, поэтому экран работает и в проде, и в ДЕМО — на одних и тех же
 * полях.
 *
 * Запреты, которые держит этот файл:
 *   • цена не пересчитывается и не «округляется» на клиенте — в `PATCH`
 *     уходит ровно то число, которое напечатано в форме и повторено на
 *     втором шаге;
 *   • правка без `comment` не отправляется: поле обязательно контрактом, и
 *     кнопка при пустом основании мертва;
 *   • `founder_month` ценой не правится (сервер отвечает
 *     `403 founder_plan_locked`), флаг `test_only` на нём — можно;
 *   • `409 price_changed` не перезаписывает чужую правку: экран перечитывает
 *     каталог и закрывает редактор.
 *
 * Чего на экране нет, потому что нет в контракте: `discount_price_stars`
 * (скидок у тарифов нет), `updated_by_name` / `updated_by_tg_id` в строке
 * каталога (кто менял — видно в истории), `is_active` в ответе `PATCH`
 * (активность тарифа из панели не меняется).
 */

import { useCallback, useState } from 'react';
import type { AdminApi } from '../api/admin';
import { ApiError } from '../api/errors';
import type { AdminPlan, AdminPlanHistoryEntry, AdminPlanPatchBody } from '../api/types';
import { Block } from '../ui/Block';
import { RouteGaps } from '../ui/RouteGaps';
import { HoldConfirm } from '../ui/HoldConfirm';
import { Banner, EmptyRow, Notice, Panel, Pill } from '../ui/primitives';
import { useResource } from '../hooks/useResource';
import { ru } from '../i18n/ru';
import { EMPTY, formatAgo, formatDateTime, formatInt } from '../lib/format';
import { checkPriceForm, echoMatches, planPriceLocked, type PriceForm } from '../lib/plansUsers';

export interface PlansProps {
  readonly api: AdminApi;
  readonly sessionLive: boolean;
  readonly demo: boolean;
  readonly now: number;
}

export function Plans({ api, sessionLive, demo, now }: PlansProps) {
  const [editing, setEditing] = useState<AdminPlan | null>(null);
  const [historyCode, setHistoryCode] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ level: 'ok' | 'warn' | 'crit'; text: string } | null>(null);

  const load = useCallback(
    async (signal: AbortSignal) => {
      const result = await api.plans(signal);
      return { data: result.data.items, demo: result.demo, requestId: result.requestId };
    },
    [api],
  );
  const { state, reload } = useResource<readonly AdminPlan[]>(load, {
    routeKey: 'plansList',
    enabled: sessionLive,
    allowMissing: demo,
  });

  // Кнопка «изменить» держит в руках актуальную строку каталога: форма правки
  // стартует от серверного `version`, а не от той, что была открыта.
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
                <>
                <table>
                  <thead>
                    <tr>
                      <th>{ru.plans.plan}</th>
                      <th>{ru.plans.kind}</th>
                      <th className="num">{ru.plans.price}</th>
                      <th>{ru.plans.flags}</th>
                      <th className="num">{ru.plans.version}</th>
                      <th>{ru.plans.updated}</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {items.length === 0 ? <EmptyRow colSpan={7} text={ru.plans.catalogEmpty} /> : null}
                    {items.map((plan) => {
                      const priceLocked = planPriceLocked(plan);
                      return (
                        <tr key={plan.code}>
                          <td>
                            {plan.title}
                            <div className="muted mono">{plan.code}</div>
                            <div className="muted">
                              {plan.period_days === null || plan.period_days === undefined
                                ? EMPTY
                                : `${formatInt(plan.period_days)} ${ru.plans.periodDays}`}
                            </div>
                          </td>
                          <td>{plan.kind === 'subscription' ? ru.plans.kindSubscription : ru.plans.kindOneOff}</td>
                          <td className="num">{formatInt(plan.price_stars)}</td>
                          <td>
                            <Pill tone={plan.active ? 'ok' : 'muted'}>{plan.active ? ru.plans.active : ru.plans.inactive}</Pill>{' '}
                            {plan.test_only ? <Pill tone="warn">{ru.plans.test}</Pill> : null}{' '}
                            {plan.founder_only ? <Pill tone="warn">{ru.plans.founder}</Pill> : null}
                          </td>
                          <td className="num mono">{formatInt(plan.version)}</td>
                          <td className="muted">{formatAgo(plan.updated_at, now)}</td>
                          <td className="row" style={{ gap: 6 }}>
                            <button
                              type="button"
                              title={priceLocked ? ru.plans.founderLocked : undefined}
                              onClick={() => { setEditing(plan); setNotice(null); }}
                            >
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
                {/* Не выдумываем то, чего сервер не присылал: кто менял — видно
                    в истории, а не в строке каталога. */}
                <p className="muted">{ru.plans.updatedByNote}</p>
                </>
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
        <RouteGaps screen="plans" anchor="gaps" />
      </div>
    </>
  );
}

/** Отказ сервера показывается его же словами: `message` + код причины + поля. */
function describe(error: ApiError): string {
  const fields = error.fieldErrors.map((item) => `${item.field}: ${item.message}`).join(' · ');
  return `${error.message}${error.reason ? ` (${error.reason})` : ''}${fields === '' ? '' : ` · ${fields}`}`;
}

/**
 * Форма правки. Два шага решает `HoldConfirm`, повтор значения — поле эха:
 * кнопка «Подтвердить ещё раз» не становится доступной, пока набранное не
 * совпало с новой ценой. Отправка — одна, без ретраев (`PATCH` не идемпотентен:
 * повтор уложил бы бы новую версию строки).
 */
function PlanEditPanel({
  api,
  plan,
  onClose,
  onDone,
}: {
  api: AdminApi;
  plan: AdminPlan;
  onClose: () => void;
  onDone: (notice: { level: 'ok' | 'warn' | 'crit'; text: string }) => void;
}) {
  const [form, setForm] = useState<PriceForm>({
    price: String(plan.price_stars),
    comment: '',
    testOnly: plan.test_only,
  });
  const [echo, setEcho] = useState('');
  const [busy, setBusy] = useState(false);

  const check = checkPriceForm(form, plan);
  // Эхо нужно ровно тогда, когда меняется число звёзд: подтверждать текстом
  // цену, которую не трогаешь, — способ утомить админа, а не поймать опечатку.
  const priceChanged = check.blocker === null && check.priceStars !== plan.price_stars;
  const echoOk = !priceChanged || echoMatches(echo, check.priceStars);
  const canSend = check.valid && !busy && echoOk;
  // Формулировку «кого касается» задаёт сервер в ответе `PATCH`
  // (`price_change_scope`); в строке каталога этого поля нет, и до правки
  // панель говорит именно это, а не придумывает правило.
  const scopeText = ru.plans.scopeUnknown;

  const submit = useCallback(async () => {
    if (!canSend) return;
    setBusy(true);
    // Собираем ровно те поля, которые отличаются: `nothing_to_update` — это
    // 422 от сервера, и создавать его панель не имеет права.
    // В тело уходит только то, что отличается: `nothing_to_update` (422)
    // панель создавать не имеет права, как и неизвестные серверу поля.
    const body: AdminPlanPatchBody = {
      ...(priceChanged ? { price_stars: check.priceStars } : {}),
      ...(check.testOnly === null ? {} : { test_only: check.testOnly }),
      ...(check.needsConfirm ? { confirm: 'disable_test_plan' as const } : {}),
      comment: form.comment.trim(),
      base_version: plan.version,
    };
    try {
      const result = await api.plansPatch(plan.code, body);
      const scope = result.data.price_change_scope;
      onDone({
        level: 'ok',
        text:
          `${ru.plans.done}: ${plan.title} · ${formatInt(result.data.plan.price_stars)} ⭐ · ` +
          `${ru.plans.effectiveFrom} ${formatDateTime(result.data.effective_from)} · ` +
          (scope === 'only_new_purchases' ? ru.plans.scopes.only_new_purchases : ru.plans.scopeUnknown),
      });
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        // Чужая правка: перечитать каталог и закрыть редактор — не «применить нашу».
        onDone({ level: 'warn', text: `${ru.plans.conflict} ${describe(error)}` });
      } else {
        onDone({ level: 'crit', text: error instanceof ApiError ? describe(error) : String(error) });
      }
    } finally {
      setBusy(false);
    }
  }, [api, canSend, check, form.comment, onDone, plan, priceChanged]);

  return (
    <Panel title={`${ru.plans.form.title} · ${plan.title}`} anchor="edit">
      <Notice>{ru.plans.form.lead}</Notice>
      {planPriceLocked(plan) ? <Banner level="warn" title={ru.plans.founderLocked} /> : null}
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
            <span className="muted">{ru.plans.form.testOnly}</span>
            <input
              type="checkbox"
              checked={form.testOnly}
              onChange={(event) => { setForm({ ...form, testOnly: event.target.checked }); }}
            />
          </label>
        </div>
        {check.needsConfirm ? <p className="muted">{ru.plans.form.testOnlyLead}</p> : null}
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
        {check.blocker === null ? null : <p className="muted">{ru.plans.blockers[check.blocker]}</p>}
        <HoldConfirm
          label={busy ? ru.plans.form.submitting : ru.plans.form.submit}
          busy={busy}
          disabled={!canSend}
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
          {echo !== '' && !echoMatches(echo, check.priceStars) ? <p className="muted">{ru.confirm.typedMismatch}</p> : null}
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

/**
 * История цены — `GET /admin/plans/{code}/history`. Строка истории содержит
 * снимок имени администратора на момент правки: имена в `users` меняются,
 * журнал — нет.
 */
function PlanHistoryPanel({ api, code, sessionLive, demo }: { api: AdminApi; code: string; sessionLive: boolean; demo: boolean }) {
  const load = useCallback(
    async (signal: AbortSignal) => {
      const result = await api.plansHistory(code, signal);
      return { data: result.data.items, demo: result.demo, requestId: result.requestId };
    },
    [api, code],
  );
  const { state, reload } = useResource<readonly AdminPlanHistoryEntry[]>(load, {
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
                <th className="num">{ru.plans.historyVersion}</th>
                <th>{ru.plans.historyComment}</th>
              </tr>
            </thead>
            <tbody>
              {items.length === 0 ? <EmptyRow colSpan={6} text={ru.plans.historyEmpty} /> : null}
              {items.map((row, index) => (
                <tr key={`${row.id}-${index}`}>
                  <td>{formatDateTime(row.effective_from)}</td>
                  <td>
                    {row.actor_name} <span className="muted mono">{row.actor_tg_id}</span>
                  </td>
                  {/* «Было» отсутствует у самой первой записи: это не 0 ⭐. */}
                  <td className="num">{row.previous_price_stars === null || row.previous_price_stars === undefined ? EMPTY : formatInt(row.previous_price_stars)}</td>
                  <td className="num">{formatInt(row.price_stars)}</td>
                  <td className="num mono">{formatInt(row.version)}</td>
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
