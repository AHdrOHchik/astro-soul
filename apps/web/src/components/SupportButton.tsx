import { Button } from '@astro-soul/ui';
import { ru } from '../i18n/ru';
import type { Telegram } from '../telegram';

export interface SupportButtonProps {
  /** Where the button leads; '' while the owner has set no contact. */
  link: string;
  telegram: Pick<Telegram, 'openLink'>;
}

/**
 * The way to support. Without a contact the button is still there, disabled and saying
 * so: a button that leads nowhere would be worse than one that admits there is nowhere yet.
 */
export function SupportButton({ link, telegram }: SupportButtonProps) {
  if (link === '') {
    return (
      <Button variant="secondary" disabled>
        {ru.support.soon}
      </Button>
    );
  }
  return (
    <Button
      variant="secondary"
      onClick={() => {
        telegram.openLink(link);
      }}
    >
      {ru.support.write}
    </Button>
  );
}
