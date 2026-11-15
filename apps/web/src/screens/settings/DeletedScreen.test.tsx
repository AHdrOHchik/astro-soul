import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ru } from '../../i18n/ru';
import { setupUser } from '../../test/fixtures';
import { DeletedScreen } from './DeletedScreen';

describe('DeletedScreen', () => {
  it('for a user with a subscription: cancellation text and Telegram link', () => {
    render(<DeletedScreen telegram={{ isTelegram: true, close: vi.fn() }} hadSubscription />);

    const message = screen.getByRole('status');
    expect(within(message).getByRole('heading', { name: 'Данные удалены' })).toBeInTheDocument();
    const lines = [...message.querySelectorAll('h2, p')].map((line) => line.textContent);
    expect(lines).toEqual([
      'Данные удалены',
      'Подписка отменена. Если захочешь вернуться — начнёшь с чистого листа.',
      'Обезличенная история платежей сохранится для бухгалтерского учёта и возвратов.',
    ]);
    expect(screen.getByRole('link', { name: 'Управлять подписками в Telegram' })).toHaveAttribute('href', 'tg://settings/star_subscriptions');
  });

  it('without a subscription snapshot (including when Me was not available): no subscription wording and no Telegram link', () => {
    // No snapshot is deliberately the safe, non-blocking default if Me could not be read.
    render(<DeletedScreen telegram={{ isTelegram: true, close: vi.fn() }} />);

    const message = screen.getByRole('status');
    expect([...message.querySelectorAll('h2, p')].map((line) => line.textContent)).toEqual([
      'Данные удалены',
      'Если захочешь вернуться — начнёшь с чистого листа.',
      'Обезличенная история платежей сохранится для бухгалтерского учёта и возвратов.',
    ]);
    expect(message.textContent).not.toMatch(/подписк/i);
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.queryByText(/tg:\/\//)).not.toBeInTheDocument();
  });

  it('the payment-history line is small print in both variants', () => {
    const { unmount } = render(<DeletedScreen telegram={{ isTelegram: true, close: vi.fn() }} hadSubscription />);
    expect(screen.getByText(ru.settings.deletion.doneNote)).toHaveClass('note');
    expect(screen.getByText(ru.settings.deletion.doneSubscriptionText)).not.toHaveClass('note');
    expect(ru.settings.deletion.confirmText).toContain(ru.settings.deletion.doneNote);
    unmount();
    render(<DeletedScreen telegram={{ isTelegram: true, close: vi.fn() }} />);
    expect(screen.getByText(ru.settings.deletion.doneNote)).toHaveClass('note');
  });

  it('closes the app in Telegram; outside it there is nothing to close', async () => {
    const close = vi.fn();
    const user = setupUser();
    const { unmount } = render(<DeletedScreen telegram={{ isTelegram: true, close }} />);

    await user.click(screen.getByRole('button', { name: ru.common.close }));
    expect(close).toHaveBeenCalledTimes(1);
    unmount();

    render(<DeletedScreen telegram={{ isTelegram: false, close }} hadSubscription />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Управлять подписками в Telegram' })).toBeInTheDocument();
  });
});
