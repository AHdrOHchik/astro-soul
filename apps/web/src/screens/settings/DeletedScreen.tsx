import { Button, ButtonLink, CheckIcon, Screen, StateView } from '@astro-soul/ui';
import { ru } from '../../i18n/ru';
import { TELEGRAM_SUBSCRIPTIONS } from '../../lib/telegramLinks';
import type { Telegram } from '../../telegram';

const copy = ru.settings.deletion;

export interface DeletedScreenProps {
  telegram: Pick<Telegram, 'isTelegram' | 'close'>;
  /**
   * The user had a subscription when they asked for the deletion, by the `Me` the settings
   * were showing then: a fact for the wording, known before the deletion and asked of nobody
   * after it. Left out, there was none as far as the app knows, and the screen says nothing
   * of one: silence is better than a statement that may be false.
   */
  hadSubscription?: boolean;
}

/**
 * After `DELETE /me`: everything is gone on the server, and the app has nothing left to
 * show or to ask for. The last screen of this start; the next one begins from nothing.
 *
 * The owner's lines, in the owner's order: the data is deleted; what became of the
 * subscription, for a user who had one; in small print, what stays. A user who had a
 * subscription also gets the way to the subscriptions in Telegram's own settings: the
 * server cancels a subscription on its side only, so Telegram is where the user sees what
 * became of it. A user who had none reads not a word about subscriptions, and has no link.
 */
export function DeletedScreen({ telegram, hadSubscription = false }: DeletedScreenProps) {
  return (
    <Screen>
      <StateView
        icon={<CheckIcon />}
        title={copy.doneTitle}
        text={hadSubscription ? copy.doneTextSubscribed : copy.doneText}
        note={copy.doneNote}
      >
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
        {hadSubscription && <ButtonLink href={TELEGRAM_SUBSCRIPTIONS}>{copy.manageSubscriptions}</ButtonLink>}
      </StateView>
    </Screen>
  );
}
