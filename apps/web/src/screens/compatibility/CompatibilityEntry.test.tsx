import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { PlanOffer } from '../../api';
import { fakeApi } from '../../test/fixtures';
import { ru } from '../../i18n/ru';
import { CompatibilityEntry } from './CompatibilityEntry';

const copy = ru.compatibility;
const chartId = '11111111-1111-4111-8111-111111111111';
const offer: PlanOffer = {
  plan_code: 'compat_249', kind: 'one_off', stars: 321, period_sec: null,
  title: 'Совместимость', subtitle: 'Серверная подпись.', includes: ['Одна пара'], test: false,
};

function setup(api = fakeApi()) {
  const onOpenForm = vi.fn();
  const onBuy = vi.fn();
  render(<CompatibilityEntry api={api} chartId={chartId} onOpenForm={onOpenForm} onBuy={onBuy} />);
  return { api, onOpenForm, onBuy };
}

describe('CompatibilityEntry', () => {
  it('subscription left zero: says when the server reopens the quota and keeps a disabled entry visible', async () => {
    const api = fakeApi();
    api.getCompatibilities.mockResolvedValue({ items: [], quota: { kind: 'subscription', left: 0, resets_at: '2026-12-18T00:00:00Z' } });
    setup(api);

    expect(await screen.findByText(copy.quotaNext('18 декабря'))).toBeInTheDocument();
    expect(screen.getByRole('button', { name: copy.entryTitle })).toBeDisabled();
    expect(api.getPlans).not.toHaveBeenCalled();
  });

  it('no quota: shows only the tariff price returned by the server', async () => {
    const api = fakeApi();
    api.getCompatibilities.mockResolvedValue({ items: [], quota: { kind: 'none', left: 0, resets_at: null } });
    api.getPlans.mockResolvedValue([offer]);
    setup(api);

    expect(await screen.findByText('321 ⭐ за одну пару')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Купить за 321 ⭐' })).toBeEnabled();
  });

  it('no tariff from the server: does not render a blank-price purchase action', async () => {
    const api = fakeApi();
    api.getCompatibilities.mockResolvedValue({ items: [], quota: { kind: 'none', left: 0, resets_at: null } });
    api.getPlans.mockResolvedValue([]);
    setup(api);

    expect(await screen.findByText(copy.noPrice)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Купить/ })).not.toBeInTheDocument();
  });
});
