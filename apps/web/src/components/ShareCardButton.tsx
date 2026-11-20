import { Button, Notice, ShareIcon } from '@astro-soul/ui';
import { useState } from 'react';
import type { Track } from '../analytics';
import type { Api, ShareCardKind } from '../api';
import { ru } from '../i18n/ru';
import type { Telegram } from '../telegram';

export function ShareCardButton({
  api,
  kind,
  telegram,
  track,
  label,
}: {
  api: Pick<Api, 'createShareCard'>;
  kind: ShareCardKind;
  telegram: Pick<Telegram, 'canSwitchInlineQuery' | 'switchInlineQuery'>;
  track: Track;
  label: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  if (!telegram.canSwitchInlineQuery) return null;

  const share = async () => {
    if (busy) return;
    setBusy(true);
    setError(false);
    track('share_clicked');
    try {
      const card = await api.createShareCard(kind);
      // `card.url` is a private, expiring file URL. Inline sharing uses only the server caption.
      if (!telegram.switchInlineQuery(card.caption)) {
        setError(true);
        return;
      }
      // TODO(1.6.9): emit client-side `share_sent` here only after the API contract allows it.
      // Contract 1.6.8 intentionally rejects this event from clients; the server owns its own event.
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  };

  return <>
    <Button variant="secondary" icon={<ShareIcon />} disabled={busy} onClick={() => { void share(); }}>
      {busy ? ru.report.sharePreparing : label}
    </Button>
    {error && <div role="status"><Notice tone="warning">{ru.report.shareFailed}</Notice></div>}
  </>;
}
