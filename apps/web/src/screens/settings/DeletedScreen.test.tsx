import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ru } from '../../i18n/ru';
import { setupUser } from '../../test/fixtures';
import { DeletedScreen } from './DeletedScreen';

describe('DeletedScreen', () => {
  it('three lines in the owner\'s order: the data is deleted; the subscription is cancelled; in small print, what stays', () => {
    render(<DeletedScreen telegram={{ isTelegram: true, close: vi.fn() }} hadSubscription />);

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
    render(<DeletedScreen telegram={{ isTelegram: true, close: vi.fn() }} hadSubscription />);

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
    render(<DeletedScreen telegram={{ isTelegram: true, close: vi.fn() }} hadSubscription />);

    const link = screen.getByRole('link', { name: 'Управлять подписками в Telegram' });
    expect(link).toHaveAttribute('href', 'tg://settings/star_subscriptions');
    // Below the three lines, not among them.
    expect(screen.getByRole('status').compareDocumentPosition(link) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('closes the app in Telegram; outside it there is nothing to close and no button, and the link is there all the same', async () => {
    const close = vi.fn();
    const user = setupUser();
    const { unmount } = render(<DeletedScreen telegram={{ isTelegram: true, close }} hadSubscription />);

    await user.click(screen.getByRole('button', { name: ru.common.close }));
    expect(close).toHaveBeenCalledTimes(1);
    unmount();

    render(<DeletedScreen telegram={{ isTelegram: false, close }} hadSubscription />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Управлять подписками в Telegram' })).toBeInTheDocument();
  });
});

/*
 * The owner's decision of iteration 8: the screen has two variants, by what the app knew of the
 * subscription before the deletion. Above is the one of a user who had a subscription (the
 * screen as it was for everyone); here, the one of a user who had none.
 */
describe('DeletedScreen: a user who had no subscription', () => {
  /** Everything a person or a screen reader can come upon: the text, and what the links and buttons hold. */
  const everything = () => document.body.innerHTML;

  it('the same three lines without the sentence about the subscription: the title, the way back, in small print what stays', () => {
    render(<DeletedScreen telegram={{ isTelegram: true, close: vi.fn() }} hadSubscription={false} />);

    const message = screen.getByRole('status');
    expect(within(message).getByRole('heading', { name: 'Данные удалены' })).toBeInTheDocument();
    expect([...message.querySelectorAll('h2, p')].map((line) => line.textContent)).toEqual([
      'Данные удалены',
      'Если захочешь вернуться — начнёшь с чистого листа.',
      'Обезличенная история платежей сохранится для бухгалтерского учёта и возвратов.',
    ]);
    expect(screen.getByText('Обезличенная история платежей сохранится для бухгалтерского учёта и возвратов.')).toHaveClass('note');
    expect(screen.getByText('Если захочешь вернуться — начнёшь с чистого листа.')).not.toHaveClass('note');
  });

  it('not a word about a subscription, and no link: neither «подписк…» nor `tg://` is anywhere on the screen', () => {
    render(<DeletedScreen telegram={{ isTelegram: true, close: vi.fn() }} hadSubscription={false} />);

    expect(screen.getByRole('main').textContent).not.toMatch(/подписк/i);
    expect(everything()).not.toMatch(/подписк/i);
    expect(everything()).not.toContain('tg://');
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    // What is left to do is to close the app.
    expect(screen.getAllByRole('button').map((button) => button.textContent)).toEqual([ru.common.close]);
  });

  it('`Me` was not there to tell by (not loaded, or the request failed), so nothing was said of a subscription: this variant, the one that claims nothing', () => {
    // The screen is told of a subscription only by a caller who knows of one; the prop left out is «not known».
    render(<DeletedScreen telegram={{ isTelegram: true, close: vi.fn() }} />);

    expect([...screen.getByRole('status').querySelectorAll('h2, p')].map((line) => line.textContent)).toEqual([
      'Данные удалены',
      'Если захочешь вернуться — начнёшь с чистого листа.',
      'Обезличенная история платежей сохранится для бухгалтерского учёта и возвратов.',
    ]);
    expect(everything()).not.toMatch(/подписк/i);
    expect(everything()).not.toContain('tg://');
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('outside Telegram there is nothing to close either: the three lines, and neither a button nor a link', () => {
    render(<DeletedScreen telegram={{ isTelegram: false, close: vi.fn() }} hadSubscription={false} />);

    expect(screen.getByRole('heading', { name: 'Данные удалены' })).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });
});

describe('DeletedScreen: the two variants side by side', () => {
  it('differ by the sentence about the subscription and by the link, and by nothing else', () => {
    const lines = (hadSubscription: boolean) => {
      const { unmount } = render(<DeletedScreen telegram={{ isTelegram: true, close: vi.fn() }} hadSubscription={hadSubscription} />);
      const found = {
        text: [...screen.getByRole('status').querySelectorAll('h2, p')].map((line) => line.textContent),
        buttons: screen.getAllByRole('button').map((button) => button.textContent),
        links: screen.queryAllByRole('link').map((link) => [link.textContent, link.getAttribute('href')]),
      };
      unmount();
      return found;
    };
    const subscribed = lines(true);
    const plain = lines(false);

    expect(subscribed.text[0]).toBe(plain.text[0]);
    expect(subscribed.text[1]).toBe(`Подписка отменена. ${String(plain.text[1])}`);
    expect(subscribed.text[2]).toBe(plain.text[2]);
    expect(subscribed.buttons).toEqual(plain.buttons);
    // `tg://settings/star_subscriptions` is on the screen of a user who had a subscription, and on no other.
    expect(subscribed.links).toEqual([['Управлять подписками в Telegram', 'tg://settings/star_subscriptions']]);
    expect(plain.links).toEqual([]);
  });

  it('neither says that the subscription lives on to the end of its period: that stopped being true with contract 1.5.5', () => {
    for (const hadSubscription of [true, false]) {
      const { unmount } = render(<DeletedScreen telegram={{ isTelegram: true, close: vi.fn() }} hadSubscription={hadSubscription} />);
      expect(screen.getByRole('main').textContent).not.toMatch(/сохраняется до конца|до конца оплаченного периода/);
      unmount();
    }
  });
});
