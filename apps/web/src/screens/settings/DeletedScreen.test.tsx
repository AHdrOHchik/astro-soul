import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ru } from '../../i18n/ru';
import { setupUser } from '../../test/fixtures';
import { DeletedScreen } from './DeletedScreen';

describe('DeletedScreen', () => {
  it('says the data are gone and makes no promise about the subscription: since contract 1.5.5 the deletion cancels it', () => {
    render(<DeletedScreen telegram={{ isTelegram: true, close: vi.fn() }} />);

    expect(screen.getByRole('heading', { name: 'Данные удалены' })).toBeInTheDocument();
    // The line of the contracts before 1.5.5, «Подписка сохраняется до конца оплаченного периода», is false now.
    expect(screen.getByRole('main').textContent).not.toMatch(/Подписка|до конца оплаченного периода/);
    // What does stay is said in the words the confirmation used before the tap: nothing new is claimed after it.
    expect(screen.getByText('Обезличенная история платежей сохранится для бухгалтерского учёта и возвратов.')).toBeInTheDocument();
    expect(ru.settings.deletion.confirmText).toContain(ru.settings.deletion.doneText);
  });

  it('closes the app in Telegram; outside it there is nothing to close and no button', async () => {
    const close = vi.fn();
    const user = setupUser();
    const { unmount } = render(<DeletedScreen telegram={{ isTelegram: true, close }} />);

    await user.click(screen.getByRole('button', { name: ru.common.close }));
    expect(close).toHaveBeenCalledTimes(1);
    unmount();

    render(<DeletedScreen telegram={{ isTelegram: false, close }} />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
