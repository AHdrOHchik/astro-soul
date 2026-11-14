import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { SupportButton } from './SupportButton';

describe('SupportButton', () => {
  it('without a contact: the button is there, disabled, and says in the owner\'s words why it leads nowhere', async () => {
    const openLink = vi.fn();
    render(<SupportButton link="" telegram={{ openLink }} />);

    const button = screen.getByRole('button', { name: 'Контакт поддержки ещё не задан' });
    expect(button).toBeDisabled();
    await userEvent.click(button);
    expect(openLink).not.toHaveBeenCalled();
    // Not a promise the build cannot keep: nothing says that support is coming.
    expect(screen.queryByText(/скоро/)).not.toBeInTheDocument();
  });

  it('with one: «Написать в поддержку» opens it', async () => {
    const openLink = vi.fn();
    render(<SupportButton link="https://t.me/astro_soul_support" telegram={{ openLink }} />);

    await userEvent.click(screen.getByRole('button', { name: 'Написать в поддержку' }));
    expect(openLink).toHaveBeenCalledWith('https://t.me/astro_soul_support');
  });
});
