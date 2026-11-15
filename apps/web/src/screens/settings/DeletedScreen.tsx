import { Button, ButtonLink, CheckIcon, Screen, StateView } from '@astro-soul/ui';
import { ru } from '../../i18n/ru';
import { TELEGRAM_SUBSCRIPTIONS } from '../../lib/telegramLinks';
import type { Telegram } from '../../telegram';

const copy = ru.settings.deletion;

/** After `DELETE /me`, show only the fact captured before the user's data was deleted. */
export function DeletedScreen({
  telegram,
  hadSubscription = false,
}: {
  telegram: Pick<Telegram, 'isTelegram' | 'close'>;
  hadSubscription?: boolean;
}) {
  return (
    <Screen>
      <StateView
        icon={<CheckIcon />}
        title={copy.doneTitle}
        text={hadSubscription ? copy.doneSubscriptionText : copy.doneText}
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
        {hadSubscription && <ButtonLink href={TELEGRAM_SUBSCRIPTIONS}>{copy.manageSubscriptions}</ButtonLink>}
      </StateView>
    </Screen>
  );
}
