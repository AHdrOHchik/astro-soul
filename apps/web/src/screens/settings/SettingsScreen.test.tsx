import { act, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Me } from '../../api';
import { ru } from '../../i18n/ru';
import { apiError, deferred, fakeAnalytics, fakeApi, fakeTelegram, meSubscribed, meWithChart, setupUser } from '../../test/fixtures';
import { DELETE_GUARD_MS, SettingsScreen, type SettingsScreenProps } from './SettingsScreen';

const copy = ru.settings;
const RESET = '2026-11-11T00:00:00.000Z';

interface SetupOptions {
  me?: Me | Promise<Me>;
  api?: ReturnType<typeof fakeApi>;
  supportLink?: string;
}

function setup({ me = meWithChart, api = fakeApi(), supportLink = '' }: SetupOptions = {}) {
  const telegram = fakeTelegram();
  const analytics = fakeAnalytics();
  const refreshMe = vi.fn<SettingsScreenProps['refreshMe']>().mockImplementation(() => Promise.resolve(me));
  const onDeleted = vi.fn();
  const onSubscribe = vi.fn();
  const onOpenDocument = vi.fn();
  // On fake timers: the last confirmation of the deletion takes its time.
  const user = setupUser();
  const view = render(
    <SettingsScreen
      api={api}
      telegram={telegram}
      refreshMe={refreshMe}
      supportLink={supportLink}
      track={analytics.track}
      onOpenDocument={onOpenDocument}
      onSubscribe={onSubscribe}
      onDeleted={onDeleted}
    />,
  );
  return { api, telegram, analytics, refreshMe, onDeleted, onSubscribe, onOpenDocument, user, ...view };
}

afterEach(() => {
  vi.useRealTimers();
});

/** Lets the timers run for `ms`. */
const pass = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

const section = (title: string) => within(screen.getByRole('region', { name: title }));
const openDeletion = () => screen.findByRole('button', { name: copy.deletion.open });
const continueDeletion = () => screen.getByRole('button', { name: copy.deletion.next });
const confirmDeletion = () => screen.getByRole('button', { name: copy.deletion.confirm });
const cancelDeletion = () => screen.getByRole('button', { name: copy.deletion.cancel });
/** From the button in the settings to the last confirmation, at the moment its button starts to take taps. */
async function toLastConfirmation(user: ReturnType<typeof setupUser>) {
  await user.click(await openDeletion());
  await user.click(continueDeletion());
  await pass(DELETE_GUARD_MS);
}

describe('SettingsScreen', () => {
  it('loading: a skeleton while the server is asked; error: the failure, with a way to repeat', async () => {
    const pending = deferred<Me>();
    const { refreshMe, user } = setup({ me: pending.promise });

    expect(screen.getByRole('status')).toHaveTextContent(copy.loading);
    expect(screen.getByRole('main')).toHaveAttribute('aria-busy', 'true');

    pending.reject(apiError('NETWORK'));
    expect(await screen.findByRole('alert')).toHaveTextContent(ru.errors.NETWORK.title);
    await user.click(screen.getByRole('button', { name: ru.common.retry }));
    expect(refreshMe).toHaveBeenCalledTimes(2);
  });

  it('empty: no subscription and no quotas are said in words, and the rest of the screen is there', async () => {
    const { onSubscribe, onOpenDocument, user } = setup();

    expect(await screen.findByText(copy.subscription.none)).toBeInTheDocument();
    expect(screen.getByText(copy.quotas.empty)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: copy.subscription.subscribe }));
    expect(onSubscribe).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: ru.consent.documents.privacy }));
    expect(onOpenDocument).toHaveBeenCalledWith('privacy');
    expect(screen.getByRole('button', { name: copy.deletion.open })).toBeEnabled();
  });

  it('ready: the plan, until when, the renewal, how to cancel in Telegram; the app itself cancels nothing', async () => {
    setup({ me: meSubscribed });

    await screen.findByText(copy.subscription.names.month);
    const subscription = section(copy.subscription.title);
    expect(subscription.getByText(new RegExp(`^Действует до \\d+ декабря 2026 г\\. ${copy.subscription.renews}$`))).toBeInTheDocument();
    expect(subscription.getByRole('heading', { name: copy.subscription.cancelTitle })).toBeInTheDocument();
    expect(subscription.getByText(copy.subscription.cancelText)).toBeInTheDocument();
    expect(subscription.getByRole('link', { name: copy.subscription.openTelegram })).toHaveAttribute('href', 'tg://settings/star_subscriptions');
    expect(subscription.queryByRole('button', { name: copy.subscription.subscribe })).not.toBeInTheDocument();
  });

  it('quotas: «left X of Y» with the time of renewal, and a limit of -1 as «no limit», never as «-1»', async () => {
    const me: Me = {
      ...meSubscribed,
      quotas: [
        { code: 'forecast_daily', used: 0, limit: -1, reset_at: RESET },
        { code: 'ask_daily', used: 2, limit: 5, reset_at: RESET },
        { code: 'compat_month', used: 3, limit: 1, reset_at: RESET },
        { code: 'report_month', used: 0, limit: 0, reset_at: RESET },
        // A quota of a newer server: this build has no name for it and shows no row under its code.
        { code: 'solar_year' as Me['quotas'][number]['code'], used: 0, limit: 1, reset_at: RESET },
      ],
    };
    setup({ me });

    const quotas = within(await screen.findByRole('list'));
    const rows = quotas.getAllByRole('listitem').map((row) => row.textContent);
    expect(rows).toHaveLength(4);
    expect(rows[0]).toBe(`${copy.quotas.names.forecast_daily}${copy.quotas.unlimited}`);
    // The day and the hour as the device's locale data writes them: «11 ноября в 03:00» or «11 ноября, 03:00».
    expect(rows[1]).toMatch(new RegExp(`^${copy.quotas.names.ask_daily}Осталось 3 из 5Обновится 1\\d ноября(,| в) \\d\\d:\\d\\d$`));
    // More used than allowed is still «0 left», not a negative number.
    expect(rows[2]).toContain('Осталось 0 из 1');
    expect(rows[3]).toBe(`${copy.quotas.names.report_month}${copy.quotas.unavailable}`);
    expect(screen.getByRole('main').textContent).not.toContain('-1');
  });

  describe('deleting the data', () => {
    it('takes two confirmations after the button: the first says what will go, the second is the last word, and only its button deletes', async () => {
      const { api, analytics, onDeleted, user } = setup();

      await user.click(await openDeletion());

      const first = within(screen.getByRole('alertdialog', { name: copy.deletion.confirmTitle }));
      for (const paragraph of copy.deletion.confirmText) expect(first.getByText(paragraph)).toBeInTheDocument();
      expect(screen.getByRole('heading', { name: copy.deletion.confirmTitle })).toHaveFocus();
      // Nothing on the first confirmation can delete.
      expect(screen.queryByRole('button', { name: copy.deletion.confirm })).not.toBeInTheDocument();

      await user.click(continueDeletion());

      const second = within(screen.getByRole('alertdialog', { name: copy.deletion.lastTitle }));
      for (const paragraph of copy.deletion.lastText) expect(second.getByText(paragraph)).toBeInTheDocument();
      expect(screen.getByRole('heading', { name: copy.deletion.lastTitle })).toHaveFocus();
      expect(api.deleteMe).not.toHaveBeenCalled();

      await pass(DELETE_GUARD_MS);
      await user.click(confirmDeletion());

      expect(api.deleteMe).toHaveBeenCalledTimes(1);
      expect(onDeleted).toHaveBeenCalledTimes(1);
      expect(analytics.events).toEqual([{ name: 'data_deleted' }]);
    });

    it('a tap repeated by accident never deletes: the last button takes none until it has been on screen for a second', async () => {
      const { api, user } = setup();

      await user.click(await openDeletion());
      await user.click(continueDeletion());

      // The second half of a double tap, wherever the layout puts the button by then.
      expect(confirmDeletion()).toBeDisabled();
      await user.click(confirmDeletion());
      // Half of the wait, not all but a millisecond: the clock of these tests also moves with the real one.
      await pass(DELETE_GUARD_MS / 2);
      expect(confirmDeletion()).toBeDisabled();
      await user.click(confirmDeletion());
      expect(api.deleteMe).not.toHaveBeenCalled();
      // «Keep» needs no waiting: it is safe at any moment.
      expect(cancelDeletion()).toBeEnabled();

      await pass(DELETE_GUARD_MS / 2);
      expect(confirmDeletion()).toBeEnabled();
      await user.click(confirmDeletion());
      expect(api.deleteMe).toHaveBeenCalledTimes(1);
    });

    it('can be backed out of at either confirmation, and starts from the first one again', async () => {
      const { api, user } = setup();

      await user.click(await openDeletion());
      await user.click(cancelDeletion());

      await user.click(await openDeletion());
      await user.click(continueDeletion());
      await user.click(cancelDeletion());

      await user.click(await openDeletion());
      expect(screen.getByRole('alertdialog', { name: copy.deletion.confirmTitle })).toBeInTheDocument();
      // Opened anew, the last confirmation waits anew.
      await user.click(continueDeletion());
      expect(confirmDeletion()).toBeDisabled();
      expect(api.deleteMe).not.toHaveBeenCalled();
    });

    it('409: the server\'s text as it is, the way to support, and `error_shown` with the status, under no other name', async () => {
      const api = fakeApi();
      const serverText = 'Не получилось вернуть звёзды за незавершённую оплату. Напиши в поддержку — вернём вручную.';
      api.deleteMe.mockRejectedValue(
        apiError('CONFLICT', { status: 409, serverMessage: serverText, requestId: 'req-409', details: { reason: 'refund_failed' } }),
      );
      const { analytics, onDeleted, telegram, user } = setup({ api, supportLink: 'https://t.me/astro_soul_help' });

      await toLastConfirmation(user);
      await user.click(confirmDeletion());

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent(serverText);
      expect(within(alert).getByRole('button', { name: ru.common.requestId('req-409') })).toBeInTheDocument();
      await user.click(within(alert).getByRole('button', { name: ru.support.write }));
      expect(telegram.openLink).toHaveBeenCalledWith('https://t.me/astro_soul_help');
      expect(onDeleted).not.toHaveBeenCalled();
      // The contract has no `data_delete_failed`: a name it does not list would cost the whole batch.
      expect(analytics.events).toEqual([{ name: 'error_shown', props: { screen: 'settings', code: '409' } }]);
    });

    it('409 without a support contact: the button is there, disabled, and says so', async () => {
      const api = fakeApi();
      api.deleteMe.mockRejectedValue(apiError('CONFLICT', { status: 409 }));
      const { user } = setup({ api });

      await toLastConfirmation(user);
      await user.click(confirmDeletion());

      const alert = await screen.findByRole('alert');
      // No text from the server: the app's own, not the generic «wait for the payment».
      expect(alert).toHaveTextContent(copy.deletion.conflict);
      expect(within(alert).getByRole('button', { name: ru.support.soon })).toBeDisabled();
    });

    it('401: the session has expired; a failure of the network: the same button deletes again; 500 is reported as 500', async () => {
      const api = fakeApi();
      api.deleteMe
        .mockRejectedValueOnce(apiError('NETWORK'))
        .mockRejectedValueOnce(apiError('INTERNAL', { status: 500 }))
        .mockRejectedValueOnce(apiError('UNAUTHORIZED', { status: 401 }));
      const { analytics, user } = setup({ api });

      await toLastConfirmation(user);
      await user.click(confirmDeletion());
      expect(await screen.findByRole('alert')).toHaveTextContent(ru.errors.NETWORK.text);

      await user.click(confirmDeletion());
      expect(await screen.findByText(new RegExp(ru.errors.INTERNAL.text))).toBeInTheDocument();

      await user.click(confirmDeletion());
      expect(await screen.findByText(new RegExp(copy.deletion.sessionExpired))).toBeInTheDocument();
      // Nothing to delete with any more: the way out is to open the app again.
      expect(screen.queryByRole('button', { name: copy.deletion.confirm })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: ru.common.close })).toBeInTheDocument();
      expect(analytics.events.map((event) => event.props)).toEqual([
        { screen: 'settings', code: 'NETWORK' },
        { screen: 'settings', code: '500' },
        { screen: 'settings', code: '401' },
      ]);
    });
  });
});
