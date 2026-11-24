import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { formatDayMonthOf } from '../i18n/format';
import { ru } from '../i18n/ru';
import { activatedAllAccess, activatedPending, entitlements, setupUser } from '../test/fixtures';
import { AccessCodeBanner } from './AccessCodeBanner';

const copy = ru.accessCode.banner;
const until = formatDayMonthOf(activatedAllAccess.all_access_until ?? '');

describe('AccessCodeBanner', () => {
  it('says what a start from a partner link opened, with its date, and goes away by one tap', async () => {
    const user = setupUser();
    render(<AccessCodeBanner startedWithCode entitlements={activatedAllAccess} />);

    expect(screen.getByRole('status', { name: copy.label })).toHaveTextContent(copy.allAccess(until));
    await user.click(screen.getByRole('button', { name: copy.dismiss }));

    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('says honestly that a code activated before the chart waits for it', () => {
    render(<AccessCodeBanner startedWithCode entitlements={activatedPending} />);

    expect(screen.getByRole('status')).toHaveTextContent(copy.pending);
  });

  it('names a partner report and a partner compatibility', () => {
    const { unmount } = render(<AccessCodeBanner startedWithCode entitlements={{ ...entitlements, source: 'partner', single_reports: 1 }} />);
    expect(screen.getByRole('status')).toHaveTextContent(copy.singleReport);
    unmount();

    render(<AccessCodeBanner startedWithCode entitlements={{ ...entitlements, source: 'partner', single_compat: 1 }} />);
    expect(screen.getByRole('status')).toHaveTextContent(copy.singleCompat);
  });

  it('stays away on an ordinary start', () => {
    render(<AccessCodeBanner startedWithCode={false} entitlements={activatedAllAccess} />);

    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('stays away when the link left no partner right behind', () => {
    render(<AccessCodeBanner startedWithCode entitlements={entitlements} />);

    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});
