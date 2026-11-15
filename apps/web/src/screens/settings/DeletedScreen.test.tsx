import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ru } from '../../i18n/ru';
import { setupUser } from '../../test/fixtures';
import { DeletedScreen } from './DeletedScreen';

describe('DeletedScreen', () => {
  it('three lines in the owner\'s order: the data is deleted; the subscription is cancelled; in small print, what stays', () => {
    render(<DeletedScreen telegram={{ isTelegram: true, close: vi.fn() }} />);

    const message = screen.getByRole('status');
    expect(within(message).getByRole('heading', { name: 'Данные удалены' })).toBeInTheDocument();
    const lines = [...message.querySelectorAll('h2, p')].map((line) => line.textContent);
    expect(lines).toEqual([
      'Данные удалены',
      'Подписка отменена. Если захочешь вернуться — начнёшь с чистого листа.',
      'Обезличенная история платежей сохранится для бухгалтерского учёта и возвратов.',
    ]);
    // The owner's sentence in one piece: «Данные удалены. Подписка отменена. Если захочешь вернуться — начнёшь с чистого листа.»
    expect(`${String(lines[0])}. ${String(lines[1])}`).toBe('Данные удалены. Подписка отменена. Если захочешь вернуться — начнёшь с чистого листа.');
  });

  it('the line about the payment history is the small print, and the one about the subscription is not', () => {
    render(<DeletedScreen telegram={{ isTelegram: true, close: vi.fn() }} />);

    // With the test setup of CSS modules a class is its own name in the stylesheet (StateView.module.css).
    expect(screen.getByText('Обезличенная история платежей сохранится для бухгалтерского учёта и возвратов.')).toHaveClass('note');
    expect(screen.getByText('Подписка отменена. Если захочешь вернуться — начнёшь с чистого листа.')).not.toHaveClass('note');
    // What stays is said in the words the first confirmation used before the tap: nothing new is claimed after it.
    expect(ru.settings.deletion.confirmText).toContain(ru.settings.deletion.doneNote);
  });

  it('nothing of the promise that stopped being true: the subscription does not live on to the end of its period', () => {
    render(<DeletedScreen telegram={{ isTelegram: true, close: vi.fn() }} />);
    expect(screen.getByRole('main').textContent).not.toMatch(/сохраняется до конца|до конца оплаченного периода/);
  });

  it('leads to the subscriptions in Telegram\'s own settings: the one place the user can see what became of the subscription', () => {
    render(<DeletedScreen telegram={{ isTelegram: true, close: vi.fn() }} />);

    const link = screen.getByRole('link', { name: 'Управлять подписками в Telegram' });
    expect(link).toHaveAttribute('href', 'tg://settings/star_subscriptions');
    // Below the three lines, not among them.
    expect(screen.getByRole('status').compareDocumentPosition(link) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('closes the app in Telegram; outside it there is nothing to close and no button, and the link is there all the same', async () => {
    const close = vi.fn();
    const user = setupUser();
    const { unmount } = render(<DeletedScreen telegram={{ isTelegram: true, close }} />);

    await user.click(screen.getByRole('button', { name: ru.common.close }));
    expect(close).toHaveBeenCalledTimes(1);
    unmount();

    render(<DeletedScreen telegram={{ isTelegram: false, close }} />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Управлять подписками в Telegram' })).toBeInTheDocument();
  });
});
