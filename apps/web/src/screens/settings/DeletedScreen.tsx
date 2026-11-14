import { Button, CheckIcon, Screen, StateView } from '@astro-soul/ui';
import { ru } from '../../i18n/ru';
import type { Telegram } from '../../telegram';

const copy = ru.settings.deletion;

/**
 * After `DELETE /me`: everything is gone on the server, and the app has nothing left to
 * show or to ask for. The last screen of this start; the next one begins from nothing.
 */
export function DeletedScreen({ telegram }: { telegram: Pick<Telegram, 'isTelegram' | 'close'> }) {
  return (
    <Screen>
      <StateView icon={<CheckIcon />} title={copy.doneTitle} text={copy.doneText}>
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
