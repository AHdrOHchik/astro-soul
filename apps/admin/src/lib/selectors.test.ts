import { describe, expect, it } from 'vitest';
import {
  codeState,
  firedAlerts,
  funnelRows,
  grantState,
  healthView,
  isUuid,
  llmSpendRows,
  pushIsSilent,
} from './selectors';
import type { AccessCode, AlertsResponse, GrantRow, Health } from '../api/types';

const NOW = Date.UTC(2026, 10, 20, 12, 0, 0);
const DAY = 86_400_000;

function code(overrides: Partial<AccessCode> = {}): AccessCode {
  return { id: '1', code: 'X', kind: 'all_access', days: 30, max_activations: 10, activations: 1, partner_name: null, is_active: true, expires_at: null, created_at: '', ...overrides };
}

function grant(overrides: Partial<GrantRow> = {}): GrantRow {
  return { id: '1', user_id: 'u', kind: 'all_access', source: 'admin', code_id: null, days: 30, starts_at: null, expires_at: null, consumed_at: null, revoked_at: null, revoked: false, created_at: '', ...overrides };
}

function alerts(items: AlertsResponse['alerts']): AlertsResponse {
  return { alerts: items, checked_at: '' };
}

describe('selectors', () => {
  it('молчание планировщика: 26 часов — тревога, 1 час — нет, выключенный пуш — не тревога', () => {
    const health = (lastRunAt: string | null, enabled = true): Health =>
      ({ status: 'ok', flags: { push: { enabled, last_run_at: lastRunAt, last_sent_count: 0 } } }) as unknown as Health;

    expect(pushIsSilent(healthView(health(new Date(NOW - 26 * DAY / 24).toISOString()), false, NOW))).toBe(true);
    expect(pushIsSilent(healthView(health(new Date(NOW - 3_600_000).toISOString()), false, NOW))).toBe(false);
    expect(pushIsSilent(healthView(health(null), false, NOW))).toBe(true);
    expect(pushIsSilent(healthView(health(null, false), false, NOW))).toBe(false);
  });

  it('503 помечается как отказ, даже если тело читается', () => {
    const view = healthView({ status: 'ok' } as unknown as Health, true, NOW);
    expect(view.httpFailed).toBe(true);
  });

  it('код: сначала выключен, потом лимит, потом срок', () => {
    expect(codeState(code({ is_active: false }), NOW)).toBe('inactive');
    expect(codeState(code({ activations: 10, max_activations: 10 }), NOW)).toBe('exhausted');
    expect(codeState(code({ expires_at: new Date(NOW - 1).toISOString() }), NOW)).toBe('expired');
    expect(codeState(code({ expires_at: new Date(NOW + DAY).toISOString() }), NOW)).toBe('active');
  });

  it('грант: отозванный важнее истёкшего, израсходованный — активнее срока', () => {
    expect(grantState(grant({ revoked: true, expires_at: new Date(NOW + DAY).toISOString() }), NOW)).toBe('revoked');
    expect(grantState(grant({ consumed_at: new Date(NOW).toISOString(), expires_at: new Date(NOW - DAY).toISOString() }), NOW)).toBe('used');
    expect(grantState(grant({ expires_at: new Date(NOW - 1).toISOString() }), NOW)).toBe('expired');
    expect(grantState(grant({ kind: 'single_report' }), NOW)).toBe('active');
  });

  it('на Обзор идут только fired; `since` не теряется', () => {
    const response = alerts([
      { id: 'llm_spend', level: 'warning', value: 1, threshold: 500, since: null, fired: false },
      { id: 'backup_stale', level: 'warning', value: 92, threshold: 36, since: '', fired: true },
    ]);
    expect(firedAlerts(response).map((item) => item.id)).toEqual(['backup_stale']);
  });

  it('воронка и траты: отсутствующее поле — null, а не 0', () => {
    expect(funnelRows({}).every((row) => row.value === null)).toBe(true);
    const rows = llmSpendRows({ forecast_cost_rub_24h: 1.5 });
    expect(rows[0]?.value).toBe(1.5);
    // Разборы за 24 часа контрактом не отдаются — строка обязана остаться без числа.
    expect(rows[3]?.value).toBeNull();
    expect(rows[3]?.label).toContain('Разборы');
  });

  it('user_id проверяется на месте, чтобы не гонять 422', () => {
    expect(isUuid('2b1f7a04-9d3c-4e21-8a55-000000000001')).toBe(true);
    expect(isUuid(' 2b1f7a04-9d3c-4e21-8a55-000000000001 ')).toBe(true);
    expect(isUuid('42')).toBe(false);
    expect(isUuid('')).toBe(false);
  });
});
