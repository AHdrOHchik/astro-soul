import { Button, Notice, ShareIcon } from '@astro-soul/ui';
import { useRef, useState } from 'react';
import type { Track } from '../analytics';
import { absoluteApiUrl, isApiError, type Api, type Me, type ShareCardKind } from '../api';
import { config } from '../config';
import { ru } from '../i18n/ru';
import { resolveShareTimeZone } from '../lib/shareTimeZone';
import type { Telegram } from '../telegram';
import styles from './ShareCardButton.module.css';

export function ShareCardButton({
  api,
  kind,
  telegram,
  track,
  label,
  share,
}: {
  api: Pick<Api, 'createShareCard'>;
  kind: ShareCardKind;
  /** Fresh server capability from GET /me; absent on pre-1.6.10 servers. */
  share?: Me['share'];
  telegram: Pick<Telegram, 'canSwitchInlineQuery' | 'switchInlineQuery' | 'canOpenLink' | 'canOpenTelegramLink' | 'openTelegramLink' | 'canShareToStory' | 'shareToStory' | 'openLink'>;
  track: Track;
  label: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [notEnough, setNotEnough] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [showOtherDestinations, setShowOtherDestinations] = useState(false);
  const inFlight = useRef(false);
  const timeZone = resolveShareTimeZone();
  const preferInline = share === undefined ? telegram.canSwitchInlineQuery : share.inline === 'on';
  const canUseInline = preferInline && telegram.canSwitchInlineQuery;

  // No server share link means this action must not be rendered or requested.
  // A moon image also needs a trustworthy local date, unlike non-date cards.
  const canOpenImage = telegram.canOpenLink || telegram.canOpenTelegramLink;
  if (share?.link === false || (kind === 'moon' && !timeZone.reliable) || (!canUseInline && !telegram.canShareToStory && !canOpenImage)) return null;

  const openGallery = (url: string): boolean => {
    try {
      if (telegram.canOpenLink) {
        telegram.openLink(url);
        return true;
      }
      return telegram.canOpenTelegramLink && telegram.openTelegramLink(url);
    } catch {
      return false;
    }
  };

  const handleShare = async (target: 'inline' | 'story' | 'gallery') => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(false);
    setNotEnough(false);
    try {
      try { track('share_clicked'); } catch { /* analytics must not block sharing */ }
      // Always get a fresh 24-hour signed URL at the moment the user chooses a destination.
      const card = await api.createShareCard(kind, timeZone.value);
      if (target === 'inline') {
        let invoked = false;
        try { invoked = telegram.switchInlineQuery(card.caption); } catch { /* Telegram may already have received the request. */ }
        if (invoked) {
          try { track('share_sent', { kind, channel: 'inline' }); } catch { /* delivery is secondary to sharing */ }
          setSheetOpen(false);
          return;
        }
        if (card.share_url !== null && telegram.canOpenTelegramLink && telegram.openTelegramLink(card.share_url)) {
          try { track('share_sent', { kind, channel: 'link' }); } catch { /* delivery is secondary to sharing */ }
          setSheetOpen(false);
          return;
        }
        setError(true);
        return;
      }

      const imageUrl = absoluteApiUrl(card.url, config.apiBaseUrl, window.location.origin);
      if (imageUrl === null) {
        setError(true);
        return;
      }
      if (target === 'story' && telegram.canShareToStory && telegram.shareToStory(imageUrl, card.caption)) {
        try { track('share_saved', { kind, target: 'telegram_story' }); } catch { /* analytics must not block an opened story editor */ }
        setSheetOpen(false);
        return;
      }

      // Telegram's native story method is unavailable (or declined): open the signed image
      // itself. The user saves it with a long press; never use <a download> in a WebView.
      if (!openGallery(imageUrl)) {
        setError(true);
        return;
      }
      try { track('share_saved', { kind, target: 'gallery' }); } catch { /* analytics must not block an opened image */ }
      setSheetOpen(false);
    } catch (reason) {
      if (kind === 'identity' && isApiError(reason) && reason.status === 422 && reason.details?.reason === 'not_enough_identity_lines') {
        setNotEnough(true);
      } else {
        setError(true);
      }
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  return <>
    <Button
      variant="secondary"
      icon={<ShareIcon />}
      disabled={busy}
      aria-expanded={sheetOpen}
      aria-controls={`share-sheet-${kind}`}
      onClick={() => { setError(false); setNotEnough(false); setSheetOpen((value) => !value); }}
    >
      {busy ? ru.report.sharePreparing : label}
    </Button>
    {error && <div role="status"><Notice tone="warning">{ru.report.shareFailed}</Notice></div>}
    {notEnough && <p className={styles.status} role="status">{ru.shareCard.notEnoughIdentityLines}</p>}
    {sheetOpen && <section id={`share-sheet-${kind}`} className={styles.sheet} aria-label={ru.shareCard.sheetTitle}>
      <div className={styles.sheetHeader}>
        <h2>{ru.shareCard.sheetTitle}</h2>
        <Button variant="ghost" onClick={() => {
          if (showOtherDestinations && canUseInline) setShowOtherDestinations(false);
          else { setSheetOpen(false); setShowOtherDestinations(false); }
        }}>{showOtherDestinations && canUseInline ? ru.shareCard.back : ru.shareCard.close}</Button>
      </div>
      <div className={styles.actions}>
        {canUseInline && !showOtherDestinations && <Button variant="secondary" disabled={busy} onClick={() => { void handleShare('inline'); }}>{ru.shareCard.inline}</Button>}
        {canUseInline && !showOtherDestinations && (telegram.canShareToStory || canOpenImage) && <Button variant="secondary" disabled={busy} onClick={() => {
          if (telegram.canShareToStory && canOpenImage) setShowOtherDestinations(true);
          else void handleShare(telegram.canShareToStory ? 'story' : 'gallery');
        }}>{telegram.canShareToStory && canOpenImage ? ru.shareCard.otherOptions : telegram.canShareToStory ? ru.shareCard.telegramStory : ru.shareCard.saveImage}</Button>}
        {(!canUseInline || showOtherDestinations) && telegram.canShareToStory && <Button variant="secondary" disabled={busy} onClick={() => { void handleShare('story'); }}>
          {ru.shareCard.telegramStory}
        </Button>}
        {(!canUseInline || showOtherDestinations) && canOpenImage && <div className={styles.galleryAction}>
          <Button variant="secondary" disabled={busy} onClick={() => { void handleShare('gallery'); }}>{ru.shareCard.saveImage}</Button>
          <p className={styles.instruction}>{ru.shareCard.saveInstruction}</p>
        </div>}
      </div>
    </section>}
  </>;
}
