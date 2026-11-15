import { act, fireEvent, render, screen, within } from '@testing-library/react';
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
  /** A clock only the test moves: for the tests of the wait before the last button takes taps. */
  manualClock?: boolean;
}

function setup({ me = meWithChart, api = fakeApi(), supportLink = '', manualClock = false }: SetupOptions = {}) {
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

    expect(await screen.findByText(copy.subscription.ended)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: copy.subscription.subscribe })).not.toBeInTheDocument();
  });

  it('shows a subscription the user has in full: the plan, until when, and how to cancel it', async () => {
    setupWithoutOffer(meSubscribed);

    await screen.findByText(copy.subscription.names.month);
    const subscription = section(copy.subscription.title);
    expect(subscription.getByText(new RegExp(`^Действует до \\d+ декабря 2026 г\\. ${copy.subscription.renews}$`))).toBeInTheDocument();
    expect(subscription.getByRole('link', { name: copy.subscription.openTelegram })).toHaveAttribute('href', 'tg://settings/star_subscriptions');
  });
});

/*
 * The screen after the deletion has two variants (the owner's decision of iteration 8): with the
 * line about the subscription and the link to Telegram's settings for a user who had one, without
 * either for a user who had none. Which it is cannot be asked after the deletion, so the settings
 * hand it on: what the `Me` they were showing said at the tap that opened the confirmations.
 */
describe('SettingsScreen: what the screen after the deletion is told about the subscription', () => {
  const withSubscription = (changes: Partial<Me['subscription']>): Me => ({
    ...meSubscribed,
    subscription: { ...meSubscribed.subscription, ...changes },
  });
  /** The way to the subscriptions in Telegram's settings, which the block of the subscription has for one in force and for no other. */
  const telegramLink = () => section(copy.subscription.title).queryByRole('link', { name: copy.subscription.openTelegram });

  it.each<[string, Me, boolean]>([
    ['a subscription that renews', meSubscribed, true],
    ['one the user has cancelled and still has paid time of', withSubscription({ auto_renew: false }), true],
    ['a trial that is running', withSubscription({ plan: 'trial' }), true],
    ['no subscription', meWithChart, false],
    ['one that has ended: the plan is named, and it is not active', withSubscription({ is_active: false }), false],
    ['an answer at odds with itself: active, of the plan `none`', withSubscription({ plan: 'none' }), false],
  ])('%s: the settings showed it as one in force or did not, and that is what is handed on', async (_case, me, expected) => {
    const { api, onDeleted, refreshMe, user } = setup({ me });
    await openDeletion();
    const shownInForce = telegramLink() !== null;

    await toLastConfirmation(user);
    await user.click(confirmDeletion());

    expect(api.deleteMe).toHaveBeenCalledTimes(1);
    expect(onDeleted).toHaveBeenCalledTimes(1);
    expect(onDeleted).toHaveBeenCalledWith(expected);
    // One and the same thing: the user who is told «the subscription is cancelled» is the user who saw one in the settings.
    expect(shownInForce).toBe(expected);
    // Known from the `Me` that was on screen: the deletion asked the server nothing more about the user, before or after.
    expect(refreshMe).toHaveBeenCalledTimes(1);
  });

  it('is what was known at the tap that opened the confirmations: a deletion that fails and is repeated hands on the same', async () => {
    const api = fakeApi();
    api.deleteMe.mockRejectedValueOnce(apiError('NETWORK')).mockRejectedValueOnce(apiError('INTERNAL', { status: 500 }));
    const { onDeleted, refreshMe, user } = setup({ api, me: meSubscribed });

    await toLastConfirmation(user);
    await user.click(confirmDeletion());
    expect(await screen.findByRole('alert')).toHaveTextContent(ru.errors.NETWORK.text);
    await user.click(confirmDeletion());
    expect(await screen.findByText(new RegExp(ru.errors.INTERNAL.text))).toBeInTheDocument();
    expect(onDeleted).not.toHaveBeenCalled();

    await user.click(confirmDeletion());

    expect(api.deleteMe).toHaveBeenCalledTimes(3);
    expect(onDeleted).toHaveBeenCalledTimes(1);
    expect(onDeleted).toHaveBeenCalledWith(true);
    expect(refreshMe).toHaveBeenCalledTimes(1);
  });

  it('backed out of and opened again, the confirmations hand on what the settings show then', async () => {
    const { onDeleted, user } = setup({ me: meWithChart });

    await user.click(await openDeletion());
    await user.click(cancelDeletion());
    await toLastConfirmation(user);
    await user.click(confirmDeletion());

    expect(onDeleted).toHaveBeenCalledTimes(1);
    expect(onDeleted).toHaveBeenCalledWith(false);
  });

  it('without `Me` (still asked for, or the request failed) nothing opens the confirmations: no deletion starts from settings that know nothing of the user', async () => {
    const pending = deferred<Me>();
    const { api, onDeleted } = setup({ me: pending.promise });

    expect(screen.getByRole('status')).toHaveTextContent(copy.loading);
    expect(screen.queryByRole('button', { name: copy.deletion.open })).not.toBeInTheDocument();

    pending.reject(apiError('NETWORK'));

    expect(await screen.findByRole('alert')).toHaveTextContent(ru.errors.NETWORK.title);
    expect(screen.queryByRole('button', { name: copy.deletion.open })).not.toBeInTheDocument();
    expect(api.deleteMe).not.toHaveBeenCalled();
    expect(onDeleted).not.toHaveBeenCalled();
  });
});
