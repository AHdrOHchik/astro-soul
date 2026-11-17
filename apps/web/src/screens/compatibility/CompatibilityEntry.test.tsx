import { fireEvent, render, screen } from '@testing-library/react';
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
  const view = render(<CompatibilityEntry api={api} chartId={chartId} onOpenForm={onOpenForm} onBuy={onBuy} />);
  return { api, onOpenForm, onBuy, ...view };
}

describe('CompatibilityEntry', () => {
  it('purchase: says it is paid and unused, and opens the form without fetching a price', async () => {
    const api = fakeApi();
    api.getCompatibilities.mockResolvedValue({ items: [], quota: { kind: 'purchase', left: 1, resets_at: null } });
    const { onOpenForm } = setup(api);

    expect(await screen.findByText(copy.quotaPaid)).toBeInTheDocument();
    await screen.findByRole('button', { name: copy.entryTitle });
    fireEvent.click(screen.getByRole('button', { name: copy.entryTitle }));
    expect(onOpenForm).toHaveBeenCalledWith(chartId);
    expect(api.getPlans).not.toHaveBeenCalled();
  });

  it('subscription left one: shows the server count/date and leaves the form action enabled', async () => {
    const api = fakeApi();
    api.getCompatibilities.mockResolvedValue({ items: [], quota: { kind: 'subscription', left: 1, resets_at: '2026-12-18T00:00:00Z' } });
    setup(api);

    expect(await screen.findByText(copy.quotaSubscription(1, '18 декабря'))).toBeInTheDocument();
    expect(screen.getByRole('button', { name: copy.entryTitle })).toBeEnabled();
    expect(api.getPlans).not.toHaveBeenCalled();
  });

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

  it('re-reads the no-store catalogue whenever the entry is reopened and shows the new server price', async () => {
    const api = fakeApi();
    api.getCompatibilities.mockResolvedValue({ items: [], quota: { kind: 'none', left: 0, resets_at: null } });
    api.getPlans.mockResolvedValueOnce([{ ...offer, stars: 1 }]).mockResolvedValueOnce([{ ...offer, stars: 2 }]);

    const first = setup(api);
    expect(await screen.findByText('1 ⭐ за одну пару')).toBeInTheDocument();
    first.unmount();
    setup(api);
    expect(await screen.findByText('2 ⭐ за одну пару')).toBeInTheDocument();
    expect(api.getPlans).toHaveBeenCalledTimes(2);
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
