import { Button, ButtonLink, CheckIcon, Screen, StateView } from '@astro-soul/ui';
import { ru } from '../../i18n/ru';
import { TELEGRAM_SUBSCRIPTIONS } from '../../lib/telegramLinks';
import type { Telegram } from '../../telegram';

const copy = ru.settings.deletion;

/**
 * After `DELETE /me`: everything is gone on the server, and the app has nothing left to
 * show or to ask for. The last screen of this start; the next one begins from nothing.
 *
 * Three lines, in the owner's order: the data is deleted; the subscription is cancelled;
 * in small print, what stays. And the way to the subscriptions in Telegram's own settings:
 * the server cancels a subscription on its side only, so Telegram is where the user sees
 * what became of it. Shown to everyone: the app does not decide by what it remembers of
 * `Me` who had a subscription.
 */
export function DeletedScreen({ telegram }: { telegram: Pick<Telegram, 'isTelegram' | 'close'> }) {
  return (
    <Screen>
      <StateView icon={<CheckIcon />} title={copy.doneTitle} text={copy.doneText} note={copy.doneNote}>
        {telegram.isTelegram && (
          <Button
            onClick={() => {
              telegram.close();
            }}
          >
            {ru.common.close}
          </Button>
        )}
        {/* A link the client itself follows, as in the settings: Telegram opens its own screen for it. */}
        <ButtonLink href={TELEGRAM_SUBSCRIPTIONS}>{copy.manageSubscriptions}</ButtonLink>
      </StateView>
    </Screen>
  );
}
