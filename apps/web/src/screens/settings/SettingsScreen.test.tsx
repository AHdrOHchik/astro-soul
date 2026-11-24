import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Me } from '../../api';
import { ru } from '../../i18n/ru';
import { apiError, cataloguePlans, compatibilityList, deferred, fakeAnalytics, fakeApi, fakeTelegram, meSubscribed, meWithChart, setupUser } from '../../test/fixtures';
import { DELETE_GUARD_MS, SettingsScreen, type SettingsScreenProps } from './SettingsScreen';

const copy = ru.settings;
const RESET = '2026-11-11T00:00:00.000Z';

interface SetupOptions {
  me?: Me | Promise<Me>;
  api?: ReturnType<typeof fakeApi>;
  supportLink?: string;
  /** A clock only the test moves: for the tests of the wait before the last button takes taps. */
  manualClock?: boolean;
  props?: Partial<SettingsScreenProps>;
}

function setup({ me = meWithChart, api = fakeApi(), supportLink = '', manualClock = false, props }: SetupOptions = {}) {
  const telegram = fakeTelegram();
  const analytics = fakeAnalytics();
  const refreshMe = vi.fn<SettingsScreenProps['refreshMe']>().mockImplementation(() => Promise.resolve(me));
  const onDeleted = vi.fn();
  const onSubscribe = vi.fn();
  const onOpenDocument = vi.fn();
  // On fake timers: the last confirmation of the deletion takes its time.
  const user = setupUser({ manual: manualClock });
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
      {...props}
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
const openDeletion = async () => {
  // Ready state: the separate loading-state delete action is covered by its own test below.
  await screen.findByRole('region', { name: copy.subscription.title });
  return screen.getByRole('button', { name: copy.deletion.open });
};
/** The same button, for a test on a clock that stands still: looked for after the settings have loaded. */
const deletionButton = () => screen.getByRole('button', { name: copy.deletion.open });
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
  it('offers the access code next to the subscription and opens it by one tap', async () => {
    const onOpenAccessCode = vi.fn();
    const { user } = setup({ props: { onOpenAccessCode } });

    const subscription = await screen.findByRole('region', { name: copy.subscription.title });
    await user.click(within(subscription).getByRole('button', { name: new RegExp(ru.accessCode.entry.title) }));

    expect(onOpenAccessCode).toHaveBeenCalledTimes(1);
  });

  it('draws the access code row for a subscriber too when the app offers it: the route itself stays open', async () => {
    // Hiding the row for a paid subscription is the app's decision, not this screen's: a gift
    // may be for a second period, and the screen must not refuse to open for one.
    setup({ me: meSubscribed, props: { onOpenAccessCode: vi.fn() } });

    const subscription = await screen.findByRole('region', { name: copy.subscription.title });
    expect(within(subscription).getByRole('button', { name: new RegExp(ru.accessCode.entry.title) })).toBeInTheDocument();
  });

  it('shows no access code row when the app does not offer it', async () => {
    setup();

    const subscription = await screen.findByRole('region', { name: copy.subscription.title });
    expect(within(subscription).queryByRole('button', { name: new RegExp(ru.accessCode.entry.title) })).not.toBeInTheDocument();
  });

  it('offers compatibility in the cabinet using the server quota and opens the current chart', async () => {
    const onOpenCompatibility = vi.fn();
    const { user } = setup({ props: { onOpenCompatibility, onBuyCompatibility: vi.fn() } });

    const entry = await screen.findByRole('region', { name: ru.compatibility.title });
    const button = await within(entry).findByRole('button', { name: ru.compatibility.entryTitle });
    await user.click(button);
    expect(onOpenCompatibility).toHaveBeenCalledWith(meWithChart.chart_id);
  });

  it('lists saved compatibility results from the server and opens the selected item', async () => {
    const api = fakeApi();
    const savedId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    api.getCompatibilities.mockResolvedValue({
      ...compatibilityList,
      items: [{ id: savedId, status: 'ready', relationship: 'friend', created_at: '2026-11-10T12:00:00Z', titles_only: ['Что совпадает'] }],
    });
    const onOpenSavedCompatibility = vi.fn();
    const { user } = setup({ api, props: { onOpenSavedCompatibility } });

    const history = await screen.findByRole('region', { name: ru.compatibility.listTitle });
    expect(within(history).getByText('Что совпадает')).toBeInTheDocument();
    await user.click(within(history).getByRole('button', { name: ru.compatibility.goTo }));
    expect(onOpenSavedCompatibility).toHaveBeenCalledWith(savedId);
  });

  it('silently filters a legacy failed compatibility from a three-item list and keeps the two valid records', async () => {
    const api = fakeApi();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    api.getCompatibilities.mockResolvedValue({
      ...compatibilityList,
      items: [
        { id: 'ready-a', status: 'ready', relationship: 'friend', created_at: '2026-11-10T12:00:00Z', titles_only: ['Готовый разбор'] },
        { id: 'failed-old', status: 'failed', relationship: 'romantic', created_at: '2026-11-11T12:00:00Z', titles_only: [] },
        { id: 'pending-b', status: 'pending', relationship: 'family', created_at: '2026-11-12T12:00:00Z', titles_only: [] },
      ],
    });
    setup({ api, props: { onOpenSavedCompatibility: vi.fn() } });
    const history = await screen.findByRole('region', { name: ru.compatibility.listTitle });
    expect(within(history).getByText('Готовый разбор')).toBeInTheDocument();
    expect(within(history).getByText(/Считается/)).toBeInTheDocument();
    expect(within(history).queryByText(/failed-old|Не получилось|Попробовать снова/)).not.toBeInTheDocument();
    expect(within(history).getAllByRole('listitem')).toHaveLength(2);
    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it('shows the empty compatibility state and a price from the live plans catalogue', async () => {
    const api = fakeApi();
    api.getCompatibilities.mockResolvedValue({ ...compatibilityList, items: [] });
    const onBuyCompatibility = vi.fn();
    setup({ api, props: { onOpenSavedCompatibility: vi.fn(), onBuyCompatibility } });
    const history = await screen.findByRole('region', { name: ru.compatibility.listTitle });
    expect(within(history).getByText(ru.compatibility.listEmpty)).toBeInTheDocument();
    const offer = cataloguePlans.find((plan) => plan.plan_code === 'compat_249' && !plan.test);
    if (offer === undefined) throw new Error('Compatibility offer missing from the test catalogue');
    const buy = await within(history).findByRole('button', { name: ru.compatibility.buy(offer.stars) });
    await setupUser().click(buy);
    expect(onBuyCompatibility).toHaveBeenCalledWith(meWithChart.chart_id);
  });

  it('loading: a skeleton while the server is asked; error: the failure, with a way to repeat', async () => {
    const pending = deferred<Me>();
    const { refreshMe, onDeleted, user } = setup({ me: pending.promise });

    expect(screen.getByRole('status')).toHaveTextContent(copy.loading);
    expect(screen.getByRole('main')).toHaveAttribute('aria-busy', 'true');

    pending.reject(apiError('NETWORK'));
    expect(await screen.findByRole('alert')).toHaveTextContent(ru.errors.NETWORK.title);
    await user.click(screen.getByRole('button', { name: ru.common.retry }));
    expect(refreshMe).toHaveBeenCalledTimes(2);

    // A failed Me read does not make deletion unavailable; only the optional wording snapshot is absent.
    await user.click(screen.getByRole('button', { name: copy.deletion.open }));
    expect(screen.getByRole('alertdialog', { name: copy.deletion.confirmTitle })).toBeInTheDocument();
    await user.click(continueDeletion());
    await pass(DELETE_GUARD_MS);
    await user.click(confirmDeletion());
    expect(onDeleted).toHaveBeenCalledWith(false);
  });

  it('deletion is available before Me loads and keeps the no-subscription variant snapshot', async () => {
    const pending = deferred<Me>();
    const { onDeleted, user } = setup({ me: pending.promise });

    await user.click(screen.getByRole('button', { name: copy.deletion.open }));
    expect(screen.getByRole('alertdialog', { name: copy.deletion.confirmTitle })).toBeInTheDocument();
    // Me arrives only after the dialog opened; it must not rewrite the captured wording fact.
    pending.resolve(meSubscribed);
    await user.click(continueDeletion());
    await pass(DELETE_GUARD_MS);
    await user.click(confirmDeletion());

    expect(onDeleted).toHaveBeenCalledWith(false);
  });

  it('empty: no subscription and no quotas are said in words, and the rest of the screen is there', async () => {
    const { onSubscribe, onOpenDocument, user } = setup();

    expect(await screen.findByText(copy.subscription.none)).toBeInTheDocument();
    expect(screen.getByText(ru.compatibility.quotaPaid)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: copy.subscription.offer }));
    expect(onSubscribe).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: ru.consent.documents.privacy }));
    expect(onOpenDocument).toHaveBeenCalledWith('privacy');
    expect(screen.getByRole('button', { name: copy.deletion.open })).toBeEnabled();
  });

  it('cancels only after confirmation and a server 200, then rereads GET /me', async () => {
    const api = fakeApi();
    const cancelled: Me = {
      ...meSubscribed,
      subscription: { ...meSubscribed.subscription, auto_renew: false, cancelled_at: '2026-11-15T10:00:00Z' },
    };
    api.cancelSubscription.mockResolvedValue({ status: 'cancelled', auto_renew: false, current_period_end: '2026-12-10T09:00:00Z' });
    const refreshMe = vi.fn<SettingsScreenProps['refreshMe']>().mockResolvedValueOnce(meSubscribed).mockResolvedValue(cancelled);
    const { user } = setup({ me: meSubscribed, api, props: { refreshMe } });

    const subscription = await screen.findByRole('region', { name: copy.subscription.title });
    expect(within(subscription).getByText(new RegExp(copy.subscription.renews))).toBeInTheDocument();
    await user.click(within(subscription).getByRole('button', { name: copy.subscription.cancelAutoRenew }));
    const confirm = screen.getByRole('alertdialog', { name: copy.subscription.cancelTitle });
    expect(within(confirm).getByText(copy.subscription.noRefundStars)).toBeInTheDocument();
    expect(api.cancelSubscription).not.toHaveBeenCalled();
    await user.click(within(confirm).getByRole('button', { name: copy.subscription.confirmCancelAction }));

    await screen.findByText(copy.subscription.cancelledAt('15 ноября 2026 г.', '10 декабря 2026 г.'));
    expect(api.cancelSubscription).toHaveBeenCalledOnce();
    expect(api.cancelSubscription.mock.calls[0]?.[0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(refreshMe).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('button', { name: copy.subscription.cancelAutoRenew })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Возобновить/i })).not.toBeInTheDocument();
  });

  it('reuses the same Idempotency-Key after a 502 retry and never shows cancellation before GET /me confirms it', async () => {
    const api = fakeApi();
    const cancelled: Me = { ...meSubscribed, subscription: { ...meSubscribed.subscription, auto_renew: false } };
    api.cancelSubscription
      .mockRejectedValueOnce(apiError('INTERNAL', { status: 502, details: { reason: 'timeout' } }))
      .mockResolvedValueOnce({ status: 'cancelled', auto_renew: false, current_period_end: '2026-12-10T09:00:00Z' });
    const refreshMe = vi.fn<SettingsScreenProps['refreshMe']>().mockResolvedValueOnce(meSubscribed).mockResolvedValue(cancelled);
    const { user } = setup({ me: meSubscribed, api, supportLink: 'https://t.me/support', props: { refreshMe } });
    const subscription = await screen.findByRole('region', { name: copy.subscription.title });
    await user.click(within(subscription).getByRole('button', { name: copy.subscription.cancelAutoRenew }));
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: copy.subscription.confirmCancelAction }));

    expect(await screen.findByText(copy.subscription.cancelFailed('10 декабря 2026 г.'))).toBeInTheDocument();
    expect(screen.getByText(new RegExp(copy.subscription.renews))).toBeInTheDocument();
    const retry = screen.getByRole('button', { name: copy.subscription.retryCancel });
    await user.click(retry);
    await screen.findByText(copy.subscription.noRenewalUntil('10 декабря 2026 г.'));
    expect(api.cancelSubscription).toHaveBeenCalledTimes(2);
    expect(api.cancelSubscription.mock.calls[1]?.[0]).toBe(api.cancelSubscription.mock.calls[0]?.[0]);
  });

  it('routes no_charge_id and gave_up to support without retrying the invalid server action', async () => {
    for (const reason of ['no_charge_id', 'gave_up']) {
      const api = fakeApi();
      api.cancelSubscription.mockRejectedValue(apiError('INTERNAL', { status: 502, details: { reason } }));
      const { user, unmount } = setup({ me: meSubscribed, api, supportLink: 'https://t.me/support' });
      const subscription = await screen.findByRole('region', { name: copy.subscription.title });
      await user.click(within(subscription).getByRole('button', { name: copy.subscription.cancelAutoRenew }));
      await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: copy.subscription.confirmCancelAction }));
      expect(await screen.findByText(reason === 'no_charge_id' ? copy.subscription.noChargeId('10 декабря 2026 г.') : copy.subscription.gaveUp('10 декабря 2026 г.'))).toBeInTheDocument();
      expect(within(screen.getByRole('alert')).getByRole('button', { name: ru.support.write })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: copy.subscription.retryCancel })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: copy.subscription.cancelAutoRenew })).not.toBeInTheDocument();
      expect(api.cancelSubscription).toHaveBeenCalledTimes(1);
      unmount();
    }
  });

  it('treats 422 as a request defect, with support and refresh but no false success or retry', async () => {
    const api = fakeApi();
    api.cancelSubscription.mockRejectedValue(apiError('VALIDATION_FAILED', { status: 422 }));
    const { user, refreshMe } = setup({ me: meSubscribed, api, supportLink: 'https://t.me/support' });
    const subscription = await screen.findByRole('region', { name: copy.subscription.title });
    await user.click(within(subscription).getByRole('button', { name: copy.subscription.cancelAutoRenew }));
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: copy.subscription.confirmCancelAction }));

    expect(await screen.findByText(copy.subscription.cancelInvalidKey)).toBeInTheDocument();
    expect(screen.getByText(new RegExp(copy.subscription.renews))).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: copy.subscription.retryCancel })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: copy.subscription.refreshStatus })).toBeInTheDocument();
    expect(api.cancelSubscription).toHaveBeenCalledOnce();
    expect(refreshMe).toHaveBeenCalledTimes(1);
  });

  it('refreshes the server state on both 409 cancellation reasons', async () => {
    for (const reason of ['already_cancelled', 'no_active_subscription']) {
      const api = fakeApi();
      api.cancelSubscription.mockRejectedValue(apiError('CONFLICT', { status: 409, details: { reason } }));
      const fresh: Me = reason === 'already_cancelled'
        ? { ...meSubscribed, subscription: { ...meSubscribed.subscription, auto_renew: false, cancelled_at: '2026-11-15T10:00:00Z' } }
        : { ...meSubscribed, subscription: { plan: 'none', is_active: false, auto_renew: false, expires_at: null } };
      const refreshMe = vi.fn<SettingsScreenProps['refreshMe']>().mockResolvedValueOnce(meSubscribed).mockResolvedValue(fresh);
      const { user, unmount } = setup({ me: meSubscribed, api, props: { refreshMe } });
      const subscription = await screen.findByRole('region', { name: copy.subscription.title });
      await user.click(within(subscription).getByRole('button', { name: copy.subscription.cancelAutoRenew }));
      await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: copy.subscription.confirmCancelAction }));
      await screen.findByText(reason === 'already_cancelled' ? copy.subscription.alreadyCancelled : copy.subscription.none);
      expect(refreshMe).toHaveBeenCalledTimes(2);
      unmount();
    }
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

    await screen.findByText(ru.compatibility.quotaPaid);
    const quotas = within(screen.getByRole('list'));
    const rows = quotas.getAllByRole('listitem').map((row) => row.textContent);
    expect(rows).toHaveLength(4);
    expect(rows[0]).toBe(`${copy.quotas.names.forecast_daily}${copy.quotas.unlimited}`);
    // The day and the hour as the device's locale data writes them: «11 ноября в 03:00» or «11 ноября, 03:00».
    expect(rows[1]).toMatch(new RegExp(`^${copy.quotas.names.ask_daily}Осталось 3 из 5Обновится 1\\d ноября(,| в) \\d\\d:\\d\\d$`));
    // More used than allowed is still «0 left», not a negative number.
    expect(rows[2]).toBe(`${copy.quotas.names.report_month}${copy.quotas.unavailable}`);
    expect(rows[3]).toContain(ru.compatibility.quotaPaid);

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
      expect(onDeleted).toHaveBeenCalledWith(false);
      expect(analytics.events).toEqual([{ name: 'data_deleted' }]);
    });

    it('captures a cancelled-but-still-active paid subscription when the user opens deletion', async () => {
      const paidButCancelled: Me = {
        ...meSubscribed,
        subscription: { ...meSubscribed.subscription, auto_renew: false },
      };
      const { onDeleted, user } = setup({ me: paidButCancelled });

      await user.click(await openDeletion());
      // It is a snapshot of the active paid period, not of auto-renewal.
      await user.click(continueDeletion());
      await pass(DELETE_GUARD_MS);
      await user.click(confirmDeletion());

      expect(onDeleted).toHaveBeenCalledWith(true);
    });

    // The two tests below count the wait to the millisecond, so their clock moves only when they move it.
    // user-event waits on timers after every action and would hang on such a clock: the taps are plain clicks.
    it('a tap repeated by accident never deletes: the last button takes none until it has been on screen for a second', async () => {
      const { api } = setup({ manualClock: true });
      await pass(0);

      fireEvent.click(deletionButton());
      fireEvent.click(continueDeletion());

      // The second half of a double tap, wherever the layout puts the button by then.
      expect(confirmDeletion()).toBeDisabled();
      fireEvent.click(confirmDeletion());
      await pass(DELETE_GUARD_MS - 1);
      expect(confirmDeletion()).toBeDisabled();
      fireEvent.click(confirmDeletion());
      expect(api.deleteMe).not.toHaveBeenCalled();
      // «Keep» needs no waiting: it is safe at any moment.
      expect(cancelDeletion()).toBeEnabled();

      await pass(1);
      expect(confirmDeletion()).toBeEnabled();
      fireEvent.click(confirmDeletion());
      expect(api.deleteMe).toHaveBeenCalledTimes(1);
    });

    it('can be backed out of at either confirmation, and starts from the first one again', async () => {
      const { api } = setup({ manualClock: true });
      await pass(0);

      fireEvent.click(deletionButton());
      fireEvent.click(cancelDeletion());

      fireEvent.click(deletionButton());
      fireEvent.click(continueDeletion());
      await pass(DELETE_GUARD_MS);
      fireEvent.click(cancelDeletion());

      fireEvent.click(deletionButton());
      expect(screen.getByRole('alertdialog', { name: copy.deletion.confirmTitle })).toBeInTheDocument();
      // Opened anew, the last confirmation waits anew.
      fireEvent.click(continueDeletion());
      expect(confirmDeletion()).toBeDisabled();
      await pass(DELETE_GUARD_MS - 1);
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

    // `details.reason` of a 409 is `refund_failed` today; the server's events know more codes (`invoice_invalidated`,
    // `user_deleted`) and will know others. The screen draws no text by any of them: it shows the server's message.
    it.each(['refund_failed', 'invoice_invalidated', 'user_deleted', 'a_reason_of_next_year', undefined])(
      '409 reads the same whatever `details.reason` says (%s)',
      async (reason) => {
        const api = fakeApi();
        const serverText = 'Не получилось вернуть звёзды за незавершённую оплату. Напиши в поддержку — вернём вручную.';
        api.deleteMe.mockRejectedValue(apiError('CONFLICT', { status: 409, serverMessage: serverText, details: reason === undefined ? undefined : { reason } }));
        const { analytics, onDeleted, user } = setup({ api });

        await toLastConfirmation(user);
        await user.click(confirmDeletion());

        const alert = await screen.findByRole('alert');
        expect(alert).toHaveTextContent(serverText);
        expect(within(alert).getByRole('button', { name: ru.support.soon })).toBeInTheDocument();
        // Nothing deleted, and the way to try again is still there.
        expect(onDeleted).not.toHaveBeenCalled();
        expect(confirmDeletion()).toBeEnabled();
        expect(analytics.events).toEqual([{ name: 'error_shown', props: { screen: 'settings', code: '409' } }]);
      },
    );

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

describe('SettingsScreen: the wording of the deletion', () => {
  /** SPEC.md, the scenario «Удаление данных», since contract 1.5.5: the deletion cancels the subscription, and the dialog says so before the tap. */
  const SUBSCRIPTION_GOES = 'Подписка при этом отменяется, доступ закрывается сразу, оплаченный период не возвращается.';
  /** What legal.md asks to say before the data goes: the payment records stay, without the person. */
  const PAYMENTS_STAY = 'Обезличенная история платежей сохранится для бухгалтерского учёта и возвратов.';

  it('the first confirmation says in plain words what the deletion does to the subscription and what stays, and its button is «Удалить данные»', async () => {
    const { api, user } = setup();
    await user.click(await openDeletion());

    const first = within(screen.getByRole('alertdialog', { name: 'Удалить все данные?' }));
    expect(first.getByText(SUBSCRIPTION_GOES)).toBeInTheDocument();
    expect(first.getByText(PAYMENTS_STAY)).toBeInTheDocument();
    // What the dialog said before contract 1.5.5 would now be a false promise about money: no word of it is left.
    expect(screen.getByRole('alertdialog').textContent).not.toMatch(/сохраняется до конца|до конца оплаченного периода/);
    expect(first.getAllByRole('button').map((button) => button.textContent)).toEqual(expect.arrayContaining(['Удалить данные', 'Не удалять']));
    expect(first.queryByRole('button', { name: 'Продолжить' })).not.toBeInTheDocument();

    // The button says what it leads to, and still deletes nothing: the last word is on the next screen.
    await user.click(first.getByRole('button', { name: 'Удалить данные' }));
    expect(screen.getByRole('alertdialog', { name: 'Точно удалить?' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Удалить навсегда' })).toBeDisabled();
    expect(api.deleteMe).not.toHaveBeenCalled();
  });

  it('a subscriber reads that the paid period is lost on the confirmation that deletes nothing yet, above its buttons', async () => {
    const { api, user } = setup({ me: meSubscribed });
    await user.click(await openDeletion());

    const first = within(screen.getByRole('alertdialog', { name: 'Удалить все данные?' }));
    const text = first.getByText(SUBSCRIPTION_GOES);
    // Above every button of this confirmation: it is read before anything can be tapped.
    for (const button of first.getAllByRole('button')) {
      expect(text.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
    // And the button that deletes is not on this confirmation at all.
    expect(screen.queryByRole('button', { name: 'Удалить навсегда' })).not.toBeInTheDocument();
    expect(api.deleteMe).not.toHaveBeenCalled();
  });
});

describe('SettingsScreen: the last confirmation, the one whose button deletes', () => {
  /** The owner's words for it, the three sentences in a row. */
  const LAST_WORD =
    'Удаляются профиль, карты, разборы, прогнозы и вопросы — в том числе купленный разбор. Подписка отменяется сразу, оплаченный период не возвращается. Восстановить данные не получится.';
  const PAID_PERIOD = 'Подписка отменяется сразу, оплаченный период не возвращается.';

  async function openLast(me?: Me) {
    const view = setup(me === undefined ? {} : { me });
    await view.user.click(await openDeletion());
    await view.user.click(continueDeletion());
    return { ...view, dialog: screen.getByRole('alertdialog', { name: 'Точно удалить?' }) };
  }

  it('says once more what goes and what it costs, word for word, and nothing else', async () => {
    const { dialog } = await openLast();

    const paragraphs = [...dialog.querySelectorAll('p')].map((paragraph) => paragraph.textContent);
    expect(paragraphs.join(' ')).toBe(LAST_WORD);
    expect(paragraphs).toHaveLength(3);
    // The text the dialog is described by is that very text: a screen reader hears it with the question.
    const describedBy = dialog.getAttribute('aria-describedby') ?? '';
    expect(document.getElementById(describedBy)?.textContent).toBe(paragraphs.join(''));
  });

  it('the sentence about the paid period stands out: bold, a paragraph of its own, never small print', async () => {
    const { dialog } = await openLast();

    const sentence = within(dialog).getByText(PAID_PERIOD);
    expect(sentence.tagName).toBe('STRONG');
    // A paragraph like the ones around it: no class that would make it smaller or paler.
    const paragraph = sentence.closest('p');
    expect(paragraph?.textContent).toBe(PAID_PERIOD);
    expect(paragraph?.className).toBe('');
    // And it is the only bold one: emphasis on everything is emphasis on nothing.
    expect(dialog.querySelectorAll('strong')).toHaveLength(1);
  });

  it('is read before the button that deletes can be tapped: the sentence stands above it, and the button waits', async () => {
    const { api, dialog } = await openLast(meSubscribed);

    const sentence = within(dialog).getByText(PAID_PERIOD);
    const button = confirmDeletion();
    expect(sentence.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(button).toBeDisabled();
    expect(api.deleteMe).not.toHaveBeenCalled();
  });

  it('is said to a user without a subscription too: the app does not decide who needs to hear it', async () => {
    const { dialog } = await openLast(meWithChart);
    expect(within(dialog).getByText(PAID_PERIOD)).toBeInTheDocument();
  });

  it('the first confirmation is as it was: its three sentences, and nothing bold', async () => {
    const { user } = setup();
    await user.click(await openDeletion());

    const first = screen.getByRole('alertdialog', { name: 'Удалить все данные?' });
    expect([...first.querySelectorAll('p')].map((paragraph) => paragraph.textContent)).toEqual([
      'Удалим профиль, карты, разборы, прогнозы и вопросы — в том числе купленный разбор. Восстановить их не получится.',
      'Подписка при этом отменяется, доступ закрывается сразу, оплаченный период не возвращается.',
      'Обезличенная история платежей сохранится для бухгалтерского учёта и возвратов.',
    ]);
    expect(first.querySelector('strong')).toBeNull();
  });
});

describe('SettingsScreen: a build that sells no subscriptions (no `onSubscribe`)', () => {
  function setupWithoutOffer(me: Me) {
    const refreshMe = vi.fn<SettingsScreenProps['refreshMe']>().mockResolvedValue(me);
    return render(
      <SettingsScreen
        api={fakeApi()}
        telegram={fakeTelegram()}
        refreshMe={refreshMe}
        supportLink=""
        track={vi.fn()}
        onOpenDocument={vi.fn()}
        onDeleted={vi.fn()}
      />,
    );
  }

  it('has no button to subscribe with; that there is no subscription is still said', async () => {
    setupWithoutOffer(meWithChart);

    expect(await screen.findByText(copy.subscription.none)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: copy.subscription.subscribe })).not.toBeInTheDocument();
    expect(screen.queryByText(copy.subscription.subscribe)).not.toBeInTheDocument();
    // The rest of the screen is as ever.
    expect(screen.getByRole('button', { name: copy.deletion.open })).toBeEnabled();
  });

  it('offers nothing after a subscription that has ended either', async () => {
    const ended: Me = { ...meSubscribed, subscription: { ...meSubscribed.subscription, is_active: false } };
    setupWithoutOffer(ended);

    expect(await screen.findByText(copy.subscription.endedAt('10 декабря 2026 г.'))).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: copy.subscription.subscribe })).not.toBeInTheDocument();
  });

  it('shows a renewing subscription and an in-app cancellation action', async () => {
    setupWithoutOffer(meSubscribed);

    await screen.findByText(copy.subscription.names.month);
    const subscription = section(copy.subscription.title);
    expect(subscription.getByText(new RegExp(`^Подписка активна до \\d+ декабря 2026 г\\. ${copy.subscription.renews}$`))).toBeInTheDocument();
    expect(subscription.getByRole('button', { name: copy.subscription.cancelAutoRenew })).toBeEnabled();
  });
});
