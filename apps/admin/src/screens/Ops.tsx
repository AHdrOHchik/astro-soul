/*
 * Экран «Эксплуатация» (ТЗ §4.6): дамп базы, переустановка вебхука и
 * подтверждение алерта. Это единственные кнопки панели, которые трогают
 * состояние сервиса, поэтому у всех трёх: обязательное основание, два нажатия
 * и текст сервера в ответ вместо пересказа.
 *
 * Честные формулировки, которые требует контракт:
 *   • `202` на дампе — «запущено», а не «сделано»: успех подтверждает маркер
 *     (`backup_stale` в алертах), не этот ответ;
 *   • `409 backup_in_progress` / `backup_too_frequent` несут
 *     `details.retry_after_seconds` — экран обязан назвать срок, если сервер
 *     его назвал, и сказать «правило не названо», если нет;
 *   • `503 backup_not_configured` — имена переменных из `details.missing`
 *     показываются списком: «не настроено» без них чинят наугад;
 *   • `502` на вебхуке — `details.last_error_message` дословно;
 *   • подтверждение алерта его не чинит: `value`, `threshold` и `since`
 *     остаются как были, меняется только показ.
 */

import { useCallback, useState } from 'react';
import type { AdminApi } from '../api/admin';
import { ApiError } from '../api/errors';
import type { Alert } from '../api/types';
import { Block } from '../ui/Block';
import { HoldConfirm } from '../ui/HoldConfirm';
import { Banner, EmptyRow, Notice, Panel, Pill } from '../ui/primitives';
import { useResource } from '../hooks/useResource';
import { ru } from '../i18n/ru';
import { EMPTY, formatClock, formatDateTime, formatInt, formatRatioRaw } from '../lib/format';
import { retryAfterDuration } from '../lib/plansUsers';

export interface OpsProps {
  readonly api: AdminApi;
  readonly sessionLive: boolean;
  readonly demo: boolean;
}

type Message = { level: 'ok' | 'warn' | 'crit'; text: string };

export function Ops({ api, sessionLive, demo }: OpsProps) {
  return (
    <>
      <h1>{ru.ops.heading}</h1>
      <p className="lead">{ru.ops.lead}</p>
      <div className="grid">
        <BackupPanel api={api} sessionLive={sessionLive} />
        <WebhookPanel api={api} sessionLive={sessionLive} />
        <AlertsPanel api={api} sessionLive={sessionLive} demo={demo} />
      </div>
    </>
  );
}

/** Сообщение об отказе: текст сервера + всё, что он добавил в `details`. */
function describeError(error: unknown): Message {
  if (!(error instanceof ApiError)) return { level: 'crit', text: String(error) };
  const parts = [`${error.message}${error.reason ? ` (${error.reason})` : ''}`];
  const retry = retryAfterDuration(error.retryAfterSeconds);
  if (error.reason === 'backup_in_progress' || error.reason === 'backup_too_frequent') {
    parts.push(error.reason === 'backup_in_progress' ? ru.ops.backupInProgress : ru.ops.backupTooFrequent);
    // Срок называется только если назвал сервер: «повтори через …» из воздуха
    // здесь хуже, чем «сервер не назвал».
    parts.push(retry === null ? ru.ops.retryUnknown : `${ru.ops.retryIn} ${retry}`);
  }
  if (error.reason === 'backup_not_configured') {
    parts.push(ru.ops.backupNotConfigured);
    parts.push(
      error.missing.length > 0
        ? `${ru.ops.backupMissing} ${error.missing.map((name) => `\`${name}\``).join(', ')}`
        // Сервер сказал «не настроено», но список не привёл — выдумывать
        // имена переменных панель не имеет права.
        : `${ru.ops.backupMissing} ${ru.ops.missingUnknown}`,
    );
  }
  if (error.status === 502 && error.upstreamMessage !== null) {
    parts.push(`${ru.ops.webhookError}: ${error.upstreamMessage}`);
  }
  // 409 — «ты не можешь этого сделать прямо сейчас», а не авария: красный
  // на «дамп уже идёт» заставляет перечитывать текст вместо того, чтобы ждать.
  return { level: error.isMissingRoute || error.status === 409 ? 'warn' : 'crit', text: parts.join(' · ') };
}

/** Основание на 5…500 знаков — общее требование трёх маршрутов. */
function useReason() {
  const [reason, setReason] = useState('');
  const trimmed = reason.trim();
  return { reason: trimmed, setReason, valid: trimmed.length >= 5 && trimmed.length <= 500 };
}

function BackupPanel({ api, sessionLive }: { api: AdminApi; sessionLive: boolean }) {
  const { reason, setReason, valid } = useReason();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message | null>(null);

  const run = useCallback(async () => {
    if (!valid || busy) return;
    setBusy(true);
    try {
      const result = await api.backupRun({ reason });
      setMessage({ level: 'ok', text: `${ru.ops.backupStarted} · ${ru.ops.backupJob} ${result.data.job_id}` });
    } catch (error) {
      setMessage(describeError(error));
    } finally {
      setBusy(false);
    }
  }, [api, busy, reason, valid]);

  return (
    <Panel title={ru.ops.backup} anchor="backup">
      <Notice>{ru.ops.backupLead}</Notice>
      {message === null ? null : <Banner level={message.level} title={message.text} />}
      <label className="field">
        {ru.ops.reason}
        <textarea rows={2} maxLength={500} value={reason} onChange={(event) => { setReason(event.target.value); }} />
      </label>
      {!valid ? <p className="muted">{ru.ops.needsReason}</p> : null}
      {/* Без сессии запрос не отправляется вообще: «401» в аудите — это не
          отказ сервиса, а наша собственная оплошность. */}
      <HoldConfirm
        label={busy ? ru.ops.backupBusy : ru.ops.backupRun}
        busy={busy}
        disabled={!valid || !sessionLive}
        onExecute={() => { void run(); }}
      >
        <p className="confirm__delta">{ru.ops.backup}: {reason === '' ? EMPTY : reason}</p>
      </HoldConfirm>
    </Panel>
  );
}

function WebhookPanel({ api, sessionLive }: { api: AdminApi; sessionLive: boolean }) {
  const { reason, setReason, valid } = useReason();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message | null>(null);

  const run = useCallback(async () => {
    if (!valid || busy) return;
    setBusy(true);
    try {
      const result = await api.webhookSet({ reason });
      setMessage({
        level: 'ok',
        // На `200` поле константное (`last_error_message: null`): Bot API ответил
        // ошибкой — это уже `502`, и её текст показывается там, дословно.
        text: `${ru.ops.webhookDone} · ${ru.ops.webhookUrl} ${result.data.url} · ${ru.ops.webhookNoError}`,
      });
    } catch (error) {
      setMessage({
        level: 'crit',
        // Ответ Bot API показывается дословно: «Webhook URL must be HTTPS»
        // полезнее, чем «что-то пошло не так».
        text: `${describeError(error).text} · ${ru.ops.webhookRejected}`,
      });
    } finally {
      setBusy(false);
    }
  }, [api, busy, reason, valid]);

  return (
    <Panel title={ru.ops.webhook} anchor="webhook">
      <Notice>{ru.ops.webhookLead}</Notice>
      {message === null ? null : <Banner level={message.level} title={message.text} />}
      <label className="field">
        {ru.ops.reason}
        <textarea rows={2} maxLength={500} value={reason} onChange={(event) => { setReason(event.target.value); }} />
      </label>
      {!valid ? <p className="muted">{ru.ops.needsReason}</p> : null}
      <HoldConfirm
        label={busy ? ru.ops.webhookBusy : ru.ops.webhookRun}
        busy={busy}
        disabled={!valid || !sessionLive}
        onExecute={() => { void run(); }}
      >
        <p className="confirm__delta">{ru.ops.webhook}: {reason === '' ? EMPTY : reason}</p>
      </HoldConfirm>
    </Panel>
  );
}

function AlertsPanel({ api, sessionLive, demo }: { api: AdminApi; sessionLive: boolean; demo: boolean }) {
  // Сообщение живёт над таблицей, а не в строке: перечитывание списка
  // размонтирует строку, и «Скрыт до 13:40» исчезало раньше, чем его успевали
  // прочитать.
  const [message, setMessage] = useState<Message | null>(null);

  const load = useCallback(
    async (signal: AbortSignal) => {
      const result = await api.alerts(signal);
      // `alerts` в ответе опционально: «списка нет» — это пустой список, не ошибка.
      return { data: (result.data.alerts ?? []).filter((item) => item.fired), demo: result.demo, requestId: result.requestId };
    },
    [api],
  );
  const { state, reload } = useResource<readonly Alert[]>(load, { routeKey: 'alerts', enabled: sessionLive, allowMissing: demo });

  return (
    <Panel title={ru.ops.alerts} anchor="alerts" onReload={reload} busy={state.kind === 'loading'}>
      <Notice>{ru.ops.alertsLead}</Notice>
      {message === null ? null : <Banner level={message.level} title={message.text} />}
      <Block state={state} onReload={reload} empty={ru.ops.alertsEmpty} isEmpty={(items) => items.length === 0}>
        {(items) => (
          <>
            <table>
              <thead>
                <tr>
                  <th>id</th>
                  <th>{ru.ops.value}</th>
                  <th>{ru.ops.threshold}</th>
                  <th>{ru.overview.alertsSince}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {items.length === 0 ? <EmptyRow colSpan={5} text={ru.ops.alertsEmpty} /> : null}
                {items.map((alert) => (
                  <tr key={alert.id}>
                    <td className="mono">{alert.id}</td>
                    {/* Значение и порог — только чтение: подтверждение их не
                        меняет, и панель их не правит и не «округляет». */}
                    <td className="num">{alert.value === null ? EMPTY : formatRatioRaw(alert.value)}</td>
                    <td className="num">{formatRatioRaw(alert.threshold)}</td>
                    <td className="muted">{formatDateTime(alert.since)}</td>
                    <td>
                      <AckControl api={api} alert={alert} onMessage={setMessage} onDone={reload} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="muted">{ru.ops.ackNote}</p>
          </>
        )}
      </Block>
    </Panel>
  );
}

/**
 * Подтверждение алерта: «скрыт до HH:MM», а не «исправлено». Срок сервер
 * считает сам — панель отправляет только `minutes`.
 */
function AckControl({
  api,
  alert,
  onMessage,
  onDone,
}: {
  readonly api: AdminApi;
  readonly alert: Alert;
  readonly onMessage: (message: Message) => void;
  readonly onDone: () => void;
}) {
  const [minutes, setMinutes] = useState('60');
  const [busy, setBusy] = useState(false);
  const value = Number(minutes.trim());
  const valid = /^\d+$/.test(minutes.trim()) && Number.isInteger(value) && value >= 15 && value <= 1440;

  const run = useCallback(async () => {
    if (!valid || busy) return;
    setBusy(true);
    try {
      const result = await api.alertAck(alert.id, { minutes: value });
      onMessage({ level: 'ok', text: `${ru.ops.ackHiddenTo} ${formatClock(result.data.acked_until)}` });
      onDone();
    } catch (error) {
      onMessage(describeError(error));
      onDone();
    } finally {
      setBusy(false);
    }
  }, [alert.id, api, busy, onDone, onMessage, valid, value]);

  return (
    <div className="row" style={{ gap: 6, alignItems: 'flex-end' }}>
      <label className="field">
        {ru.ops.ackMinutes}
        <input type="text" inputMode="numeric" value={minutes} onChange={(event) => { setMinutes(event.target.value); }} aria-invalid={minutes.trim() !== '' && !valid} />
      </label>
      {/* Подсказка называет диапазон, а не «нужно значение»: 10 — это значение,
          просто вне дозволенного, и человек должен видеть границу, а не гадать. */}
      <span className="muted">{valid ? ru.ops.ackMinutesHint : ru.ops.ackMinutesInvalid}</span>
      <HoldConfirm label={busy ? ru.ops.ackBusy : ru.ops.ack} busy={busy} disabled={!valid} onExecute={() => { void run(); }}>
        <p className="confirm__delta">
          <Pill tone={alert.level === 'critical' ? 'crit' : 'warn'}>{alert.level === 'critical' ? ru.alertLevels.critical : ru.alertLevels.warning}</Pill>{' '}
          {alert.id} · {ru.ops.value} {alert.value === null ? EMPTY : formatRatioRaw(alert.value)} · {ru.ops.threshold}{' '}
          {formatRatioRaw(alert.threshold)} · {ru.ops.ackMinutes} {formatInt(value)}
        </p>
      </HoldConfirm>
    </div>
  );
}
