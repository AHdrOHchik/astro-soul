import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ApiError, type Me, type ShareCardKind } from '../api';
import { ru } from '../i18n/ru';
import { fakeAnalytics, fakeApi, fakeTelegram } from '../test/fixtures';
import { ShareCardButton } from './ShareCardButton';

const card = {
  url: '/api/v1/files/card/card.png?sig=fresh',
  share_url: 'https://t.me/astro_soul_bot?start=sh_k7m2p9x4qz',
  expires_at: '2026-11-16T10:00:00Z',
  caption: 'Exact server caption',
};

function setup({
  kind = 'day',
  share = { link: true, inline: 'off' as const },
  story = false,
  canOpenLink = true,
}: {
  kind?: ShareCardKind;
  share?: Me['share'];
  story?: boolean;
  canOpenLink?: boolean;
} = {}) {
  const api = fakeApi();
  api.createShareCard.mockResolvedValue(card);
  const telegram = fakeTelegram({ canShareToStory: story, canOpenLink });
  const analytics = fakeAnalytics();
  const user = userEvent.setup();
  const label = kind === 'moon' ? ru.shareCard.moon : kind === 'identity' ? ru.shareCard.identity : ru.shareCard.day;
  const view = render(
    <ShareCardButton
      api={api}
      kind={kind}
      telegram={telegram}
      track={analytics.track}
      label={label}
      share={share}
    />,
  );
  return { ...view, api, telegram, analytics, user };
}

async function openSheet(user: ReturnType<typeof userEvent.setup>, label: string = ru.shareCard.day) {
  await user.click(screen.getByRole('button', { name: label }));
  return screen.findByRole('region', { name: ru.shareCard.sheetTitle });
}

describe('ShareCardButton: cards for stories and the gallery', () => {
  it('renders no share controls or sheet when GET /me says there is no share link', () => {
    const { api } = setup({ share: { link: false, inline: 'on' } });
    expect(screen.queryByRole('button', { name: ru.shareCard.day })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: ru.shareCard.sheetTitle })).not.toBeInTheDocument();
    expect(api.createShareCard).not.toHaveBeenCalled();
  });

  it('puts inline first when Me.share.inline is on and sends only the generated identity kind', async () => {
    const { api, telegram, analytics, user } = setup({ kind: 'identity', share: { link: true, inline: 'on' }, story: true });
    const sheet = await openSheet(user, ru.shareCard.identity);
    const buttons = within(sheet).getAllByRole('button');
    expect(buttons.map((button) => button.textContent)).toEqual([
      ru.shareCard.close,
      ru.shareCard.inline,
      ru.shareCard.otherOptions,
    ]);
    expect(buttons.slice(1)).toHaveLength(2);
    await user.click(screen.getByRole('button', { name: ru.shareCard.otherOptions }));
    const otherDestinations = await screen.findByRole('region', { name: ru.shareCard.sheetTitle });
    expect(within(otherDestinations).getAllByRole('button').map((button) => button.textContent)).toEqual([
      ru.shareCard.back,
      ru.shareCard.telegramStory,
      ru.shareCard.saveImage,
    ]);
    await user.click(screen.getByRole('button', { name: ru.shareCard.back }));

    await user.click(screen.getByRole('button', { name: ru.shareCard.inline }));

    expect(api.createShareCard).toHaveBeenCalledWith('identity', expect.any(String));
    expect(telegram.switchInlineQuery).toHaveBeenCalledWith(card.caption);
    expect(analytics.events.filter(({ name }) => name === 'share_sent')).toEqual([
      { name: 'share_sent', props: { kind: 'identity', channel: 'inline' } },
    ]);
  });

  it('requests a fresh signed URL on every save and opens the image, not a download link', async () => {
    const { api, telegram, analytics, user } = setup({ kind: 'moon' });
    api.createShareCard
      .mockResolvedValueOnce(card)
      .mockResolvedValueOnce({ ...card, url: '/api/v1/files/card/card.png?sig=next' });

    await openSheet(user, ru.shareCard.moon);
    expect(screen.getByText(ru.shareCard.saveInstruction)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: ru.shareCard.saveImage }));
    expect(api.createShareCard).toHaveBeenCalledWith('moon', expect.any(String));
    expect(telegram.openLink).toHaveBeenCalledWith('http://localhost:3000/api/v1/files/card/card.png?sig=fresh');

    await openSheet(user, ru.shareCard.moon);
    await user.click(screen.getByRole('button', { name: ru.shareCard.saveImage }));
    expect(api.createShareCard).toHaveBeenCalledTimes(2);
    expect(telegram.openLink).toHaveBeenLastCalledWith('http://localhost:3000/api/v1/files/card/card.png?sig=next');
    expect(analytics.events.filter(({ name }) => name === 'share_saved')).toEqual([
      { name: 'share_saved', props: { kind: 'moon', target: 'gallery' } },
      { name: 'share_saved', props: { kind: 'moon', target: 'gallery' } },
    ]);
    expect(JSON.stringify(analytics.events)).not.toContain('sig=');
  });

  it('uses openTelegramLink for the signed image when the general openLink bridge is unavailable', async () => {
    const { telegram, analytics, user } = setup({ canOpenLink: false });
    await openSheet(user);
    await user.click(screen.getByRole('button', { name: ru.shareCard.saveImage }));
    expect(telegram.openTelegramLink).toHaveBeenCalledWith('http://localhost:3000/api/v1/files/card/card.png?sig=fresh');
    expect(telegram.openLink).not.toHaveBeenCalled();
    expect(analytics.events).toContainEqual({ name: 'share_saved', props: { kind: 'day', target: 'gallery' } });
  });

  it('uses native story sharing when available and records the story target', async () => {
    const { telegram, analytics, user } = setup({ story: true });
    await openSheet(user);
    await user.click(screen.getByRole('button', { name: ru.shareCard.telegramStory }));
    expect(telegram.shareToStory).toHaveBeenCalledWith('http://localhost:3000/api/v1/files/card/card.png?sig=fresh', card.caption);
    expect(telegram.openLink).not.toHaveBeenCalled();
    expect(analytics.events).toContainEqual({ name: 'share_saved', props: { kind: 'day', target: 'telegram_story' } });
  });

  it('does not offer Telegram stories when unsupported, and still offers image saving', async () => {
    const { telegram, analytics, user } = setup({ story: false });
    const sheet = await openSheet(user);
    expect(within(sheet).queryByRole('button', { name: ru.shareCard.telegramStory })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: ru.shareCard.saveImage }));
    expect(telegram.shareToStory).not.toHaveBeenCalled();
    expect(telegram.openLink).toHaveBeenCalledWith('http://localhost:3000/api/v1/files/card/card.png?sig=fresh');
    expect(analytics.events).toContainEqual({ name: 'share_saved', props: { kind: 'day', target: 'gallery' } });
  });

  it('shows the identity empty-state text without showing a generic error for 422', async () => {
    const { api, user } = setup({ kind: 'identity' });
    api.createShareCard.mockRejectedValue(new ApiError('VALIDATION_FAILED', {
      status: 422,
      details: { reason: 'not_enough_identity_lines' },
    }));
    await openSheet(user, ru.shareCard.identity);
    await user.click(screen.getByRole('button', { name: ru.shareCard.saveImage }));
    expect(await screen.findByRole('status')).toHaveTextContent(ru.shareCard.notEnoughIdentityLines);
    expect(screen.queryByText(ru.report.shareFailed)).not.toBeInTheDocument();
  });
});
