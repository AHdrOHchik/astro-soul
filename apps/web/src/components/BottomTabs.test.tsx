import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import * as bridge from '../telegram';
import { BottomTabs } from './BottomTabs';

it('only gives selection feedback when switching tabs', () => {
  const feedback = vi.spyOn(bridge, 'haptic');
  const select = vi.fn();
  const view = render(<BottomTabs active="map" onSelect={select} />);
  fireEvent.scroll(screen.getByRole('navigation'));
  fireEvent.click(screen.getByRole('button', { name: 'Карта' }));
  fireEvent.click(screen.getByRole('button', { name: 'Сегодня' }));
  view.rerender(<BottomTabs active="today" onSelect={select} />);
  fireEvent.click(screen.getByRole('button', { name: 'Сегодня' }));
  expect(feedback.mock.calls).toEqual([['selection']]);
  expect(select).toHaveBeenCalledWith('today');
});
