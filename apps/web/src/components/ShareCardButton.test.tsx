import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { Me } from '../api';
import { fakeAnalytics, fakeApi, fakeTelegram } from '../test/fixtures';
import { ShareCardButton } from './ShareCardButton';

const label = 'Поделиться';
const shareLink = 'https://t.me/astro_soul_bot?start=sh_k7m2p9x4qz';

type Capability = NonNullable<Me['share']>;

function setup(share?: Capability, { canSwitchInlineQuery = true, canOpenTelegramLink = true } = {}) {
  const api = fakeApi();
  const telegram = fakeTelegram({ canSwitchInlineQuery, canOpenTelegramLink });
  const analytics = fakeAnalytics();
  const user = userEvent.setup();
  const element = (capability?: Capability) => (
    <ShareCardButton
      api={api}
      kind="wheel"
      telegram={telegram}
      track={analytics.track}
      label={label}
      share={capability}
    />
  );
  const view = render(element(share));
  return { ...view, api, telegram, analytics, user, element };
}

describe('ShareCardButton: GET /me share capability', () => {
  it('does not render or request a card when the server has no share link', () => {
    const { api } = setup({ link: false, inline: 'on' });
    expect(screen.queryByRole('button', { name: label })).not.toBeInTheDocument();
    expect(api.createShareCard).not.toHaveBeenCalled();
  });

  it('does not offer a link-only share mode when Telegram cannot open links', () => {
    const { api } = setup({ link: true, inline: 'unknown' }, { canOpenTelegramLink: false });
    expect(screen.queryByRole('button', { name: label })).not.toBeInTheDocument();
    expect(api.createShareCard).not.toHaveBeenCalled();
  });

  it('uses inline when the server says it is on', async () => {
    const { api, telegram, analytics, user } = setup({ link: true, inline: 'on' });
    await user.click(screen.getByRole('button', { name: label }));
    expect(api.createShareCard).toHaveBeenCalledOnce();
    expect(telegram.switchInlineQuery).toHaveBeenCalledWith('Мне тут сделали разбор личности — залипательно');
    expect(telegram.openTelegramLink).not.toHaveBeenCalled();
    expect(analytics.events.filter(({ name }) => name === 'share_sent')).toEqual([
      { name: 'share_sent', props: { kind: 'wheel', channel: 'inline' } },
    ]);
  });

  it.each(['off', 'unknown'] as const)('uses only the server link when inline is %s', async (inline) => {
    const { api, telegram, analytics, user } = setup({ link: true, inline });
    await user.click(screen.getByRole('button', { name: label }));
    expect(api.createShareCard).toHaveBeenCalledOnce();
    expect(telegram.switchInlineQuery).not.toHaveBeenCalled();
    expect(telegram.openTelegramLink).toHaveBeenCalledWith(shareLink);
    expect(analytics.events.filter(({ name }) => name === 'share_sent')).toEqual([
      { name: 'share_sent', props: { kind: 'wheel', channel: 'link' } },
    ]);
  });

  it('keeps the 1.6.9 behavior when the optional capability is absent', async () => {
    const inline = setup(undefined);
    await inline.user.click(screen.getByRole('button', { name: label }));
    expect(inline.telegram.switchInlineQuery).toHaveBeenCalledWith('Мне тут сделали разбор личности — залипательно');
    inline.unmount();

    const link = setup(undefined, { canSwitchInlineQuery: false });
    await link.user.click(screen.getByRole('button', { name: label }));
    expect(link.telegram.switchInlineQuery).not.toHaveBeenCalled();
    expect(link.telegram.openTelegramLink).toHaveBeenCalledWith(shareLink);
  });

  it('uses an updated inline value on the same mounted button', async () => {
    const { api, telegram, analytics, user, rerender, element } = setup({ link: true, inline: 'off' });
    await user.click(screen.getByRole('button', { name: label }));
    expect(telegram.openTelegramLink).toHaveBeenCalledWith(shareLink);
    expect(telegram.switchInlineQuery).not.toHaveBeenCalled();

    rerender(element({ link: true, inline: 'on' }));
    await user.click(screen.getByRole('button', { name: label }));
    expect(api.createShareCard).toHaveBeenCalledTimes(2);
    expect(telegram.switchInlineQuery).toHaveBeenCalledWith('Мне тут сделали разбор личности — залипательно');
    expect(analytics.events.filter(({ name }) => name === 'share_sent')).toEqual([
      { name: 'share_sent', props: { kind: 'wheel', channel: 'link' } },
      { name: 'share_sent', props: { kind: 'wheel', channel: 'inline' } },
    ]);
  });
});
