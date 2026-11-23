/*
 * Экран «Обзор» (ТЗ §4.1). Собран только из того, что отдают `/health`,
 * `GET /admin/alerts` и `GET /admin/metrics` — ни одной цифры «для примера».
 *
 * Что сознательно не сделано:
 *   • воронка за 24 часа и за 7 дней: маршрут отдаёт окно 30 дней, и окно
 *     подписано прямо в блоке, чтобы его не приняли за суточное;
 *   • топ-5 провалов генераций: `GET /admin/reports?status=failed` в контракте
 *     нет, блок показывает «Недоступно в этой версии» и не рисует данных.
 */

import { useCallback } from 'react';
import type { AdminApi } from '../api/admin';
import type { AccessCode, Alert, AlertsResponse, Health, Metrics } from '../api/types';
import { unavailable, type Resource } from '../api/state';
import { Block } from '../ui/Block';
import { Banner, EmptyRow, KeyValue, Notice, Panel, Pill, Stat } from '../ui/primitives';
import { useResource } from '../hooks/useResource';
import { ru } from '../i18n/ru';
import {
  EMPTY,
  formatAgo,
  formatBool,
  formatDateTime,
  formatHours,
  formatInt,
  formatRatio,
  formatRatioRaw,
  formatRub,
  formatStars,
  formatUsage,
} from '../lib/format';
import {
  breakerRows,
  firedAlerts,
  funnelRows,
  grantRows,
  grantsBySource,
  healthView,
  llmSpendRows,
  paymentRows,
  pushIsSilent,
  pushMetricRows,
  type HealthView,
} from '../lib/selectors';

/** Ответ `/health` вместе с HTTP-статусом: 503 — это тоже прочитанный ответ. */
interface HealthSnapshot {
  readonly health: Health;
  readonly failed: boolean;
}

const LEVEL_LABEL: Record<string, string> = {
  critical: ru.alertLevels.critical,
  warning: ru.alertLevels.warning,
};

const WEBHOOK_LABEL: Record<string, string> = {
  ok: ru.webhookStates.ok,
  stale: ru.webhookStates.stale,
  unreachable: ru.webhookStates.unreachable,
};

function toneFor(value: string | null): 'ok' | 'crit' | 'warn' | 'muted' {
  if (value === null) return 'muted';
  if (value === 'ok') return 'ok';
  if (value === 'down' || value === 'unreachable') return 'crit';
  return 'warn';
}

function healthRows(view: HealthView) {
  return [
    {
      label: ru.overview.status,
      value: <Pill tone={view.status === 'ok' && !view.httpFailed ? 'ok' : 'crit'}>{view.status === 'unknown' ? EMPTY : view.status}</Pill>,
    },
    { label: ru.overview.db, value: <Pill tone={toneFor(view.db)}>{view.db ?? EMPTY}</Pill> },
    { label: ru.overview.llm, value: <Pill tone={toneFor(view.llm)}>{view.llm ?? EMPTY}</Pill> },
    { label: ru.overview.astro, value: <Pill tone={toneFor(view.astro)}>{view.astro ?? EMPTY}</Pill> },
    {
      label: ru.overview.webhook,
      value: (
        <Pill tone={toneFor(view.webhook)}>{view.webhook === null ? EMPTY : (WEBHOOK_LABEL[view.webhook] ?? view.webhook)}</Pill>
      ),
    },
    {
      label: ru.overview.testPlans,
      value: (
        <Pill tone={view.testPlans === true ? 'crit' : 'muted'}>
          {view.testPlans === null ? EMPTY : view.testPlans ? ru.overview.testPlansOn : ru.overview.testPlansOff}
        </Pill>
      ),
    },
    { label: ru.overview.reportBreaker, value: formatBool(view.reportBreaker, 'включён', 'выключен') },
    {
      label: ru.overview.bonusBudget,
      value: (
        <>
          {formatRub(view.bonusSpent)} / {formatRub(view.bonusLimit)}{' '}
          {view.bonusExhausted === true ? <Pill tone="crit">{ru.overview.bonusBudgetExhausted}</Pill> : null}
        </>
      ),
    },
  ];
}

/** Строка «планировщик пуша»: включён, последний прогон, и явно — «молчит N часов». */
function PushLine({ view }: { view: HealthView }) {
  const silent = pushIsSilent(view);
  return (
    <>
      <div className="row">
        <Pill tone={view.pushEnabled === true ? (silent ? 'crit' : 'ok') : 'muted'}>
          {view.pushEnabled === null ? EMPTY : view.pushEnabled ? ru.overview.pushEnabled : ru.overview.pushDisabled}
        </Pill>
        <span className="muted">
          {ru.overview.pushLastRun}: {view.pushLastRunAt === null ? ru.overview.pushNever : formatDateTime(view.pushLastRunAt)}
        </span>
        <span className="muted">
          {ru.overview.pushLastSent}: {formatInt(view.pushLastSent)}
        </span>
        {silent && view.pushSilentHours !== null ? (
          <Pill tone="crit">
            {ru.overview.pushSilent} {formatHours(view.pushSilentHours)}
          </Pill>
        ) : null}
      </div>
      {silent ? <Banner level="crit" title={ru.overview.pushSilent}>{ru.overview.pushSilentWarn}</Banner> : null}
    </>
  );
}

function AlertTable({ alerts, now }: { alerts: readonly Alert[]; now: number }) {
  return (
    <table>
      <thead>
        <tr>
          <th>id</th>
          <th>{ru.overview.alertsValue}</th>
          <th className="num">{ru.overview.alertsThreshold}</th>
          <th>{ru.overview.alertsSince}</th>
        </tr>
      </thead>
      <tbody>
        {alerts.map((alert) => (
          <tr key={alert.id}>
            <td className="mono">
              {alert.id} <Pill tone={alert.level === 'critical' ? 'crit' : 'warn'}>{LEVEL_LABEL[alert.level] ?? alert.level}</Pill>
            </td>
            <td>{typeof alert.value === 'number' ? formatInt(alert.value) : EMPTY}</td>
            <td className="num">{formatInt(alert.threshold)}</td>
            <td>{alert.since ? formatAgo(alert.since, now) : EMPTY}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export interface OverviewProps {
  readonly api: AdminApi;
  /** Сессия есть: без неё приватные блоки не опрашиваются, а объясняют почему. */
  readonly sessionLive: boolean;
  readonly now: number;
}

export function Overview({ api, sessionLive, now }: OverviewProps) {
  // Загрузчики мемоизированы: `useResource` кладёт их в зависимости эффекта, и
  // стрелка на каждом рендере означала бы новый запрос на каждый рендер.
  const loadHealth = useCallback(
    async (signal: AbortSignal) => {
      const result = await api.health(signal);
      return { data: { health: result.data, failed: result.status === 503 }, demo: result.demo, requestId: result.requestId };
    },
    [api],
  );
  const loadAlerts = useCallback(async (signal: AbortSignal) => await api.alerts(signal), [api]);
  const loadMetrics = useCallback(async (signal: AbortSignal) => await api.metrics(signal), [api]);

  const health = useResource<HealthSnapshot>(loadHealth, { routeKey: 'health' });
  const alerts = useResource<AlertsResponse>(loadAlerts, { routeKey: 'alerts', enabled: sessionLive });
  const metrics = useResource<Metrics>(loadMetrics, { routeKey: 'metrics', enabled: sessionLive });

  // Маршрута нет в контракте — состояние статичное, запрос не отправляется.
  const reportsState: Resource<readonly AccessCode[]> = unavailable('reportsList');

  const needSession = !sessionLive ? <Banner level="warn" title={ru.states.unauthorized}>{ru.overview.publicOnly}</Banner> : null;

  return (
    <>
      <h1>{ru.overview.heading}</h1>
      <p className="lead">{ru.overview.lead}</p>

      <div className="grid">
        <Panel title={ru.overview.health} anchor="health" onReload={health.reload} busy={health.state.kind === 'loading'}>
          <Block state={health.state} onReload={health.reload}>
            {(data) => {
              const view = healthView(data.health, data.failed, now);
              return (
                <>
                  {data.failed ? <Banner level="crit" title={ru.overview.healthDown} /> : null}
                  {view.status === 'degraded' && !data.failed ? <Banner level="crit" title={ru.overview.healthDegraded} /> : null}
                  {view.status === 'unknown' ? <Banner level="warn" title={`${ru.states.error}: ${ru.overview.health}`} /> : null}
                  <KeyValue rows={healthRows(view)} />
                  <div>
                    <strong>{ru.overview.push}</strong>
                    <PushLine view={view} />
                  </div>
                  <p className="muted">
                    {ru.overview.healthVersion}: <span className="mono">{view.version ?? EMPTY}</span> · {ru.overview.healthChecked}{' '}
                    {formatDateTime(view.checkedAt)}
                  </p>
                </>
              );
            }}
          </Block>
        </Panel>

        <Panel title={ru.overview.alerts} anchor="alerts" onReload={alerts.reload} busy={alerts.state.kind === 'loading'}>
          {needSession ?? (
            <Block
              state={alerts.state}
              onReload={alerts.reload}
              empty={ru.overview.alertsClear}
              isEmpty={(data) => firedAlerts(data).length === 0}
            >
              {(data) => <AlertTable alerts={firedAlerts(data)} now={now} />}
            </Block>
          )}
        </Panel>
      </div>

      <div className="grid" style={{ marginTop: 12 }}>
        <Panel title={ru.overview.funnel} anchor="funnel" onReload={metrics.reload} busy={metrics.state.kind === 'loading'}>
          {needSession ?? (
            <Block state={metrics.state} onReload={metrics.reload}>
              {(data) => (
                <>
                  <Notice>{ru.overview.funnelWindow}</Notice>
                  <div className="stats">
                    <Stat label={ru.overview.funnelUsers} value={formatInt(data.mau)} />
                    <Stat label={ru.overview.funnelPaying} value={formatInt(data.paying)} />
                    <Stat
                      label={ru.overview.funnelConversion}
                      value={formatRatio(data.conversion_to_paid)}
                      hint={`conversion_to_paid = ${formatRatioRaw(data.conversion_to_paid)}`}
                    />
                    <Stat label={ru.overview.stars} value={formatStars(data.stars_received_30d)} />
                  </div>
                  <table>
                    <thead>
                      <tr>
                        <th>{ru.overview.funnelColumn}</th>
                        <th className="num">человек</th>
                      </tr>
                    </thead>
                    <tbody>
                      {funnelRows(data).map((row) => (
                        <tr key={row.label}>
                          <td>{row.label}</td>
                          <td className="num">{formatInt(row.value)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              )}
            </Block>
          )}
        </Panel>

        <Panel title={ru.overview.llmSpend} anchor="llm" onReload={metrics.reload} busy={metrics.state.kind === 'loading'}>
          {needSession ?? (
            <Block state={metrics.state} onReload={metrics.reload}>
              {(data) => (
                <>
                  <table>
                    <thead>
                      <tr>
                        <th>статья</th>
                        <th className="num">{ru.overview.llmSpend24h}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {llmSpendRows(data).map((row) => (
                        <tr key={row.label}>
                          <td>
                            {row.label}
                            {row.note ? <div className="muted">{row.note}</div> : null}
                          </td>
                          <td className="num">{row.value === null ? EMPTY : formatRub(row.value)}</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr>
                        <td>{ru.overview.llmSpend30d}</td>
                        <td className="num">{formatRub(data.llm_cost_rub_30d)}</td>
                      </tr>
                    </tfoot>
                  </table>
                  <div className="stats">
                    {breakerRows(data).map((row) => (
                      <Stat key={row.label} label={row.label} value={formatInt(row.value)} />
                    ))}
                    <Stat
                      label={ru.overview.breakerReports}
                      value={data.reports_breaker_open ? ru.overview.breakerOpen : ru.overview.breakerClosed}
                      hint={
                        data.reports_breaker_last_failed_at
                          ? `${ru.overview.breakerLast}: ${formatAgo(data.reports_breaker_last_failed_at, now)}`
                          : undefined
                      }
                    />
                  </div>
                </>
              )}
            </Block>
          )}
        </Panel>
      </div>

      <div className="grid" style={{ marginTop: 12 }}>
        <Panel title={ru.overview.payments} anchor="payments">
          {needSession ?? (
            <Block state={metrics.state} onReload={metrics.reload}>
              {(data) => (
                <KeyValue
                  rows={paymentRows(data).map((row) => ({ label: row.label, value: row.value === null ? EMPTY : formatInt(row.value) }))}
                />
              )}
            </Block>
          )}
        </Panel>

        <Panel title={ru.overview.pushCounters} anchor="push">
          {needSession ?? (
            <Block state={metrics.state} onReload={metrics.reload}>
              {(data) => (
                <KeyValue
                  rows={pushMetricRows(data).map((row) => ({ label: row.label, value: row.value === null ? EMPTY : formatInt(row.value) }))}
                />
              )}
            </Block>
          )}
        </Panel>

        <Panel title={ru.overview.grantsCounters} anchor="grants">
          {needSession ?? (
            <Block state={metrics.state} onReload={metrics.reload}>
              {(data) => (
                <>
                  <KeyValue
                    rows={grantRows(data).map((row) => ({ label: row.label, value: row.value === null ? EMPTY : formatInt(row.value) }))}
                  />
                  <table>
                    <thead>
                      <tr>
                        <th>{ru.overview.grantsBySource}</th>
                        <th className="num">{ru.overview.llmSpend24h}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {grantsBySource(data).length === 0 ? (
                        <EmptyRow colSpan={2} text={ru.states.empty} />
                      ) : (
                        grantsBySource(data).map((row) => (
                          <tr key={row.source}>
                            <td className="mono">{row.source}</td>
                            <td className="num">{formatInt(row.value)}</td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                  <p className="muted">
                    {ru.overview.grantsLost}: {formatRub(data.grants_revenue_lost_rub_24h)} · {ru.overview.bonusBudget}{' '}
                    {formatUsage(data.bonus_budget_spent_rub, data.bonus_budget_limit_rub)}
                  </p>
                </>
              )}
            </Block>
          )}
        </Panel>

        <Panel title={ru.overview.topFailed} anchor="failed">
          <Block state={reportsState}>{() => null}</Block>
        </Panel>
      </div>
    </>
  );
}
