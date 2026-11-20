import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { CompatibilityList } from '../../api';
import { ru } from '../../i18n/ru';
import { fakeApi } from '../../test/fixtures';
import { CompatibilityHistory, type CompatibilityHistoryCache } from './CompatibilityHistory';

const item = (index: number): CompatibilityList['items'][number] => ({
  id: `compat-${String(index)}`,
  status: 'ready',
  relationship: 'friend',
  created_at: '2026-11-15T10:00:00Z',
  titles_only: [`Сохранённый разбор ${String(index)}`],
});
const page = (items: CompatibilityList['items'], total: number, offset: number): CompatibilityList => ({
  items, total, limit: 20, offset, quota: { kind: 'purchase', left: 1, resets_at: null },
});
function renderHistory(api: ReturnType<typeof fakeApi>, cache: { current: CompatibilityHistoryCache | null }) {
  const scrollContainer = { current: null as HTMLElement | null };
  return render(<CompatibilityHistory api={api} onOpen={vi.fn()} chartId="chart-1" cache={cache.current} onCacheChange={(value) => { cache.current = value; }} scrollContainer={scrollContainer}/>);
}

describe('CompatibilityHistory pagination', () => {
  it('requests the next page at the loaded offset, preserves rows after a failure, then retries', async () => {
    const api = fakeApi();
    const first = Array.from({ length: 20 }, (_, index) => item(index));
    const last = item(20);
    api.getCompatibilities.mockResolvedValueOnce(page(first, 21, 0))
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce(page([last], 21, 20));
    const cache = { current: null as CompatibilityHistoryCache | null };
    renderHistory(api, cache);

    expect(await screen.findByText(ru.compatibility.listCount(21))).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: ru.compatibility.listLoadMore }));
    expect(await screen.findByText(ru.compatibility.listLoadMoreError)).toBeInTheDocument();
    expect(screen.getByText('Сохранённый разбор 0')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: ru.common.retry }));
    expect(await screen.findByText('Сохранённый разбор 20')).toBeInTheDocument();
    expect(api.getCompatibilities.mock.calls.map(([limit, offset]) => [limit, offset])).toEqual([[20, 0], [20, 20], [20, 20]]);
    expect(screen.getByText(ru.compatibility.listCount(21))).toBeInTheDocument();
  });

  it('does not show empty state for an empty last page with total > 0 and reuses cache without refetching page one', async () => {
    const api = fakeApi();
    const first = Array.from({ length: 20 }, (_, index) => item(index));
    api.getCompatibilities.mockResolvedValueOnce(page(first, 25, 0)).mockResolvedValueOnce(page([], 25, 20));
    const cache = { current: null as CompatibilityHistoryCache | null };
    const view = renderHistory(api, cache);

    expect(await screen.findByText('Сохранённый разбор 0')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: ru.compatibility.listLoadMore }));
    await waitFor(() => { expect(cache.current?.hasMore).toBe(false); });
    expect(screen.queryByText(ru.compatibility.listEmpty)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: ru.compatibility.listLoadMore })).not.toBeInTheDocument();
    view.unmount();
    renderHistory(api, cache);
    expect(screen.getByText('Сохранённый разбор 0')).toBeInTheDocument();
    expect(api.getCompatibilities).toHaveBeenCalledTimes(2);
  });
});
