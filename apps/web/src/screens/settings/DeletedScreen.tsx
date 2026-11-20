import { Button, CheckIcon, Screen, StateView } from '@astro-soul/ui';
import { ru } from '../../i18n/ru';
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
      </StateView>
    </Screen>
  );
}
