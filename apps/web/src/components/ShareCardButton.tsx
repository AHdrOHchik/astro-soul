import { Button, Notice, ShareIcon } from '@astro-soul/ui';
import { useRef, useState } from 'react';
import type { Track } from '../analytics';
import type { Api, Me, ShareCardKind } from '../api';
import { ru } from '../i18n/ru';
import type { Telegram } from '../telegram';

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
  telegram: Pick<Telegram, 'canSwitchInlineQuery' | 'switchInlineQuery' | 'canOpenTelegramLink' | 'openTelegramLink'>;
  track: Track;
  label: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [unavailableFor, setUnavailableFor] = useState<string | null>(null);
  const inFlight = useRef(false);
  const capabilityKey = share === undefined ? 'legacy' : `${share.link}:${share.inline}`;
  const preferInline = share === undefined ? telegram.canSwitchInlineQuery : share.inline === 'on';
  const canUseInline = preferInline && telegram.canSwitchInlineQuery;
  const canUseLink = telegram.canOpenTelegramLink;
  if (share?.link === false || unavailableFor === capabilityKey || (!canUseInline && !canUseLink)) return null;

  const handleShare = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(false);
    try { track('share_clicked'); } catch { /* analytics must not block sharing */ }
    try {
      const card = await api.createShareCard(kind);
      // `url` is a private, expiring file URL. It must never be sent to Telegram.
      if (canUseInline) {
        let invoked = false;
        try { invoked = telegram.switchInlineQuery(card.caption); } catch { /* Telegram may already have received the request. */ }
        if (invoked) {
          try { track('share_sent', { kind, channel: 'inline' }); } catch { /* delivery is secondary to sharing */ }
          return;
        }
      }
      if (card.share_url === null) {
        // There is no link fallback. Keep the button away after learning this from the server.
        setUnavailableFor(capabilityKey);
        return;
      }
      if (!telegram.canOpenTelegramLink || !telegram.openTelegramLink(card.share_url)) {
        setError(true);
        return;
      }
      try { track('share_sent', { kind, channel: 'link' }); } catch { /* delivery is secondary to sharing */ }
    } catch {
      setError(true);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  return <>
    <Button variant="secondary" icon={<ShareIcon />} disabled={busy} onClick={() => { void handleShare(); }}>
      {busy ? ru.report.sharePreparing : label}
    </Button>
    {error && <div role="status"><Notice tone="warning">{ru.report.shareFailed}</Notice></div>}
  </>;
}
