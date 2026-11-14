import { act, render, screen, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAnalytics } from './analytics';
import type { ChartResult, Me, TimePrecision } from './api';
import { App } from './App';
import { SEARCH_DEBOUNCE_MS } from './hooks/usePlaceSearch';
import { CONFIRM_INTERVAL_MS } from './screens/paywall/PaywallScreen';
import { DELETE_GUARD_MS } from './screens/settings/SettingsScreen';
import { CONSENT_VERSION, ru } from './i18n/ru';
import {
  apiError,
  askAnswer,
  chartRequest,
  chartResult,
  deferred,
  fakeAnalytics,
  fakeApi,
  fakeKeys,
  fakeTelegram,
  fakeTermsReload,
  forecast,
  freeForecast,
  kazan,
  me,
  meAsking,
  mePaid,
  meWithChart,
  rejection,
  report,
  REPORT_ID,
  sections,
  setupUser,
  TODAY,
} from './test/fixtures';

type FakeUser = ReturnType<typeof setupUser>;

interface SetupOptions {
  telegram?: Parameters<typeof fakeTelegram>[0];
  api?: (api: ReturnType<typeof fakeApi>) => void;
  /** What the start before this one left behind, and whether this browser keeps anything at all. */
  termsReload?: Parameters<typeof fakeTermsReload>[0];
  /** Renders as a development build does: every effect runs twice. */
  strict?: boolean;
}

function setup(options: SetupOptions = {}) {
  const api = fakeApi();
  options.api?.(api);
  const telegram = fakeTelegram(options.telegram);
  const analytics = fakeAnalytics();
  const termsReload = fakeTermsReload(options.termsReload);
  const keys = fakeKeys();
  const user = setupUser();
  const app = (
    <App
      api={api}
      telegram={telegram}
      apiBaseUrl="https://api.test"
      keys={keys}
      track={analytics.track}
      termsReload={termsReload}
      today={TODAY}
    />
  );
  const view = render(options.strict ? <StrictMode>{app}</StrictMode> : app);
  return { api, telegram, analytics, termsReload, keys, user, ...view };
}

const start = () => screen.findByRole('button', { name: ru.welcome.start });
const next = () => screen.getByRole('button', { name: ru.common.next });
const heading = () => screen.getByRole('heading', { level: 1 });
const consentBox = () => screen.getByRole('checkbox', { name: ru.consent.checkbox });
const proceed = () => screen.getByRole('button', { name: ru.consent.submit });
const notNow = () => screen.getByRole('button', { name: ru.consent.decline });
/** The small print under «Начать», the way to the agreement. */
const termsLine = () =>
  screen.getByRole('button', { name: `${ru.welcome.terms.before}${ru.welcome.terms.link}${ru.welcome.terms.after}` });
const buildChart = () => screen.getByRole('button', { name: ru.birthPlace.submit });
const settleSearch = () => act(() => vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS));

/** From the welcome screen to the consent screen. */
async function openConsent(user: FakeUser) {
  await user.click(await start());
}

async function giveConsent(user: FakeUser) {
  await openConsent(user);
  await user.click(consentBox());
  await user.click(proceed());
}

async function enterDate(user: FakeUser, digits = '17051994') {
  await giveConsent(user);
  await user.keyboard(digits);
  await user.click(next());
}

async function enterTime(user: FakeUser, mode: TimePrecision, digits = '') {
  await user.click(screen.getByRole('radio', { name: ru.birthTime.options[mode].title }));
  if (digits) await user.keyboard(digits);
  await user.click(next());
}

async function enterPlace(user: FakeUser) {
  await user.type(screen.getByLabelText(ru.birthPlace.label), 'Каз');
  await settleSearch();
  await user.click(screen.getByRole('button', { name: /Казань/ }));
  await user.click(buildChart());
}

/** Every step with the data of the `chartRequest` fixture, up to the request for the chart. */
async function fillIn(user: FakeUser) {
  await enterDate(user);
  await enterTime(user, 'exact', '1430');
  await enterPlace(user);
}

/** The handler the app last registered for Telegram's native Back button. */
function backHandler(telegram: ReturnType<typeof fakeTelegram>) {
  return telegram.setBackHandler.mock.lastCall?.[0] ?? null;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('App: sign-in', () => {
  it('shows a skeleton while /me is loading, then the welcome screen with the disclaimer', async () => {
    const pending = deferred<Me>();
    const { api, telegram } = setup({ api: (fake) => fake.getMe.mockImplementation(() => pending.promise) });

    expect(screen.getByRole('main')).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('status')).toHaveTextContent(ru.common.loading);
    expect(telegram.ready).toHaveBeenCalledTimes(1);
    expect(api.getMe).toHaveBeenCalledTimes(1);

    await act(async () => {
      pending.resolve(me);
      await pending.promise;
    });

    expect(heading()).toHaveTextContent(ru.welcome.title);
    expect(heading()).toHaveFocus();
    expect(screen.getByText(ru.welcome.disclaimer)).toBeInTheDocument();
    expect(ru.welcome.disclaimer).toMatch(/18\+/);
    expect(ru.welcome.disclaimer).toMatch(/развлекательный/);
    expect(screen.getByRole('button', { name: ru.welcome.start })).toBeInTheDocument();
    expect(termsLine()).toBeInTheDocument();
    expect(telegram.ready).toHaveBeenCalledTimes(1);
  });

  it('shows the error state when /me fails and recovers on retry', async () => {
    const { api, user } = setup({
      api: (fake) =>
        fake.getMe
          .mockRejectedValueOnce(apiError('INTERNAL', { status: 500, serverMessage: 'Сервис временно недоступен.', requestId: 'req-1' }))
          .mockResolvedValueOnce(me),
    });

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(ru.errors.INTERNAL.title);
    expect(alert).toHaveTextContent('Сервис временно недоступен.');
    expect(screen.getByText(ru.common.requestId('req-1'))).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: ru.welcome.start })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: ru.common.retry }));

    expect(await start()).toBeInTheDocument();
    expect(api.getMe).toHaveBeenCalledTimes(2);
  });

  it('falls back to its own wording when the failure carries no server message', async () => {
    setup({ api: (fake) => fake.getMe.mockRejectedValue(apiError('NETWORK')) });

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(ru.errors.NETWORK.title);
    expect(alert).toHaveTextContent(ru.errors.NETWORK.text);
    expect(screen.getByRole('button', { name: ru.common.retry })).toBeInTheDocument();
  });

  it('on 401 inside Telegram offers to close the app instead of a retry that cannot help', async () => {
    const { telegram, user } = setup({ api: (fake) => fake.getMe.mockRejectedValue(apiError('UNAUTHORIZED', { status: 401 })) });

    expect(await screen.findByRole('alert')).toHaveTextContent(ru.errors.UNAUTHORIZED.title);
    expect(screen.queryByRole('button', { name: ru.common.retry })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: ru.common.close }));
    expect(telegram.close).toHaveBeenCalledTimes(1);
  });

  it('on 401 outside Telegram explains where to open the app', async () => {
    setup({
      telegram: { isTelegram: false, initData: '', hasNativeBackButton: false },
      api: (fake) => fake.getMe.mockRejectedValue(apiError('UNAUTHORIZED', { status: 401, serverMessage: 'initData is missing' })),
    });

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(ru.outsideTelegram.title);
    expect(alert).toHaveTextContent(ru.outsideTelegram.text);
    expect(alert).not.toHaveTextContent('initData is missing');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

});

describe('App: a user who already has a chart', () => {
  const returning: Me = { ...me, is_new: false, has_profile: true, has_chart: true, chart_id: chartResult.chart.chart_id };
  const restored: ChartResult = { ...chartResult, is_restored: true };

  it('opens on the chart from the server; the form is one tap away, and «Не сейчас» leads back to the chart', async () => {
    const { api, analytics, telegram, user } = setup({
      api: (fake) => {
        fake.getMe.mockResolvedValue(returning);
        fake.getCurrentChart.mockResolvedValue(restored);
      },
    });

    expect(await screen.findByRole('region', { name: ru.chart.sun })).toBeInTheDocument();
    expect(heading()).toHaveTextContent(ru.chart.title);
    expect(api.createChart).not.toHaveBeenCalled();
    expect(analytics.events).toEqual([
      { name: 'app_open' },
      { name: 'screen_view', props: { step: 'chart' } },
      { name: 'chart_restored' },
    ]);
    // The first screen of this start: nothing to go back to.
    expect(telegram.setBackHandler).toHaveBeenLastCalledWith(null);

    await user.click(screen.getByRole('button', { name: ru.chart.enterAgain }));
    // The consent is asked anew: the one given for the old chart was not given in this session.
    expect(heading()).toHaveTextContent(ru.consent.title);
    expect(consentBox()).not.toBeChecked();

    analytics.clear();
    await user.click(notNow());
    expect(await screen.findByRole('region', { name: ru.chart.sun })).toBeInTheDocument();
    // The chart the screen already showed: the server is not asked again, and nothing is counted as restored twice.
    expect(api.getCurrentChart).toHaveBeenCalledTimes(1);
    expect(analytics.names()).not.toContain('chart_restored');
  });

  it('starts the onboarding when the server has no chart after all', async () => {
    const { api } = setup({ api: (fake) => fake.getMe.mockResolvedValue(returning) });

    expect(await start()).toBeInTheDocument();
    expect(heading()).toHaveTextContent(ru.welcome.title);
    expect(api.getCurrentChart).toHaveBeenCalledTimes(1);
  });

  it('does not ask a new user\'s server for a chart it cannot have', async () => {
    const { api } = setup();

    await start();
    expect(api.getCurrentChart).not.toHaveBeenCalled();
  });
});

describe('App: the full report, the paywall and the settings', () => {
  const restored: ChartResult = { ...chartResult, is_restored: true };
  const chartId = chartResult.chart.chart_id;
  const teaserCta = () => screen.findByRole('button', { name: new RegExp(`^${ru.chart.teaserCta} `) });
  const payButton = () => screen.findByRole('button', { name: new RegExp(`^${ru.paywall.pay} `) });

  /** A user who has a chart; `fake` prepares the rest of the server. */
  const returning = (prepare?: (fake: ReturnType<typeof fakeApi>) => void) =>
    setup({
      api: (fake) => {
        fake.getMe.mockResolvedValue(meWithChart);
        fake.getCurrentChart.mockResolvedValue(restored);
        prepare?.(fake);
      },
    });

  it('from the teaser to the report: the paywall opens with the report chosen for this chart, and the order follows the server\'s word', async () => {
    const { api, analytics, user } = returning((fake) => {
      // Before the purchase the server grants nothing; asked after it, it does.
      fake.getMe.mockResolvedValueOnce(meWithChart).mockResolvedValue(mePaid);
    });

    await user.click(await teaserCta());
    expect(heading()).toHaveTextContent(ru.paywall.title);
    expect(screen.getByRole('radio', { name: new RegExp(`^${ru.paywall.plans.one_149.title} `) })).toBeChecked();

    await user.click(await payButton());

    expect(await screen.findByRole('heading', { level: 1, name: ru.report.queuedTitle })).toBeInTheDocument();
    expect(api.createInvoice).toHaveBeenCalledWith({ plan_code: 'one_149', chart_id: chartId }, expect.any(AbortSignal));
    expect(api.orderReport).toHaveBeenCalledTimes(1);
    expect(api.orderReport).toHaveBeenCalledWith({ chart_id: chartId, type: 'full' }, 'key-1', expect.any(AbortSignal));
    expect(analytics.names()).toEqual([
      'app_open',
      'screen_view',
      'chart_restored',
      'screen_view',
      'paywall_view',
      'checkout_started',
      'checkout_opened',
      'payment_succeeded',
      'screen_view',
      'report_requested',
    ]);
  });

  it('the way back from the report is the chart itself: not the paywall, and no second request for the chart', async () => {
    const { api, telegram, user } = returning((fake) => {
      fake.getMe.mockResolvedValueOnce(meWithChart).mockResolvedValue(mePaid);
    });
    await user.click(await teaserCta());
    await user.click(await payButton());
    await screen.findByRole('heading', { level: 1, name: ru.report.queuedTitle });

    const back = telegram.setBackHandler.mock.lastCall?.[0];
    act(() => {
      back?.();
    });

    expect(heading()).toHaveTextContent(ru.chart.title);
    expect(await screen.findByRole('region', { name: ru.chart.sun })).toBeInTheDocument();
    expect(api.getCurrentChart).toHaveBeenCalledTimes(1);
    // The server says the report is paid for now, and names it: the chart offers the way to it instead of the price.
    expect(await screen.findByRole('button', { name: ru.chart.openReport })).toBeInTheDocument();
    expect(api.getReport).toHaveBeenLastCalledWith(REPORT_ID, expect.any(AbortSignal));
  });

  it('a payment the server has not confirmed is not offered a second time: the chart says it is being processed', async () => {
    const { api, analytics, user } = returning();

    await user.click(await teaserCta());
    await user.click(await payButton());
    // Telegram said «paid»; the server, asked twice, grants nothing yet.
    await act(() => vi.advanceTimersByTimeAsync(CONFIRM_INTERVAL_MS));
    await user.click(await screen.findByRole('button', { name: ru.paywall.leave }));

    expect(await screen.findByText(ru.chart.paymentPending)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: new RegExp(`^${ru.chart.teaserCta} `) })).not.toBeInTheDocument();

    // The server has it now: the next question brings the way to the report, and still no price.
    api.getMe.mockResolvedValue(mePaid);
    await user.click(screen.getByRole('button', { name: ru.paywall.checkAgain }));

    expect(await screen.findByRole('button', { name: ru.chart.orderReport })).toBeInTheDocument();
    expect(screen.queryByText(ru.chart.paymentPending)).not.toBeInTheDocument();
    expect(api.createInvoice).toHaveBeenCalledTimes(1);
    // Confirmed late and from another screen: the payment is counted all the same, once.
    expect(analytics.events.filter((event) => event.name === 'payment_succeeded')).toEqual([
      { name: 'payment_succeeded', props: { plan_code: 'one_149' } },
    ]);
  });

  it('a refused order (402) leads to the paywall, which says why it opened, with the report chosen', async () => {
    const { user } = returning((fake) => {
      fake.getMe.mockResolvedValue(mePaid);
      fake.orderReport.mockRejectedValue(apiError('PAYMENT_REQUIRED', { status: 402 }));
    });

    await user.click(await screen.findByRole('button', { name: ru.chart.orderReport }));

    expect(await screen.findByRole('heading', { level: 1, name: ru.paywall.title })).toBeInTheDocument();
    expect(screen.getByRole('note')).toHaveTextContent(ru.paywall.reportRequired);
    expect(screen.getByRole('radio', { name: new RegExp(`^${ru.paywall.plans.one_149.title} `) })).toBeChecked();
  });

  it('opens the report the server names in `Me` without waiting to be asked', async () => {
    const { api, user } = returning((fake) => {
      fake.getMe.mockResolvedValue({ ...mePaid, latest_report_id: REPORT_ID });
      fake.getReport.mockResolvedValue({ ...report, status: 'ready', progress: 100, sections });
    });

    expect(await screen.findByText(ru.chart.reportStates.ready)).toBeInTheDocument();
    expect(api.getReport).toHaveBeenCalledWith(REPORT_ID, expect.any(AbortSignal));

    await user.click(screen.getByRole('button', { name: ru.chart.openReport }));

    expect(await screen.findByRole('region', { name: sections[0]?.title })).toBeInTheDocument();
    expect(api.orderReport).not.toHaveBeenCalled();
  });

  it('`Me` names a report the server no longer has (404): no error anywhere, the chart is what it is with no report, and the app forgets the id', async () => {
    const { api, analytics, telegram, user } = returning((fake) => {
      // At start `Me` still names the report; the report itself went with the data, and the next `Me` says so: null.
      fake.getMe.mockResolvedValueOnce({ ...mePaid, latest_report_id: REPORT_ID }).mockResolvedValue({ ...mePaid, latest_report_id: null });
      fake.getReport.mockRejectedValue(apiError('NOT_FOUND', { status: 404, requestId: 'req-404' }));
    });

    // Paid for, and no report: the chart offers to get one, as it does when `Me` says null.
    expect(await screen.findByRole('button', { name: ru.chart.orderReport })).toBeInTheDocument();
    expect(api.getReport).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByText(/req-404/)).not.toBeInTheDocument();
    expect(analytics.names()).not.toContain('error_shown');

    // Forgotten: `null` in the next `Me` is the ordinary «no report», and coming back to the chart
    // does not ask about the old id again (it would, had the app kept it).
    await user.click(screen.getByRole('button', { name: ru.common.settings }));
    expect(heading()).toHaveTextContent(ru.settings.title);
    const back = telegram.setBackHandler.mock.lastCall?.[0];
    act(() => {
      back?.();
    });

    expect(heading()).toHaveTextContent(ru.chart.title);
    expect(await screen.findByRole('button', { name: ru.chart.orderReport })).toBeInTheDocument();
    expect(api.getReport).toHaveBeenCalledTimes(1);
  });

  it('settings are a tap away from the chart; deleting the data ends the app on the screen that says so, and nothing more is reported', async () => {
    const { api, analytics, keys, telegram, user } = returning();
    // An order made earlier left its key on the device.
    const kept = keys.current(chartId, 'full');

    await user.click(await screen.findByRole('button', { name: ru.common.settings }));
    expect(heading()).toHaveTextContent(ru.settings.title);
    // The settings show the user as the server has them now, not as the app remembers.
    expect(api.getMe).toHaveBeenCalledTimes(2);

    // The button, then two confirmations: only the second one deletes, and not in its first second.
    await user.click(await screen.findByRole('button', { name: ru.settings.deletion.open }));
    await user.click(screen.getByRole('button', { name: ru.settings.deletion.next }));
    await act(() => vi.advanceTimersByTimeAsync(DELETE_GUARD_MS));
    expect(api.deleteMe).not.toHaveBeenCalled();
    analytics.clear();
    await user.click(screen.getByRole('button', { name: ru.settings.deletion.confirm }));

    expect(await screen.findByRole('heading', { name: ru.settings.deletion.doneTitle })).toBeInTheDocument();
    expect(screen.getByText(ru.settings.deletion.doneText)).toBeInTheDocument();
    expect(api.deleteMe).toHaveBeenCalledTimes(1);
    expect(analytics.names()).toEqual(['data_deleted']);
    // The keys of the orders went with the data: the same chart id would get a new one.
    expect(keys.current(chartId, 'full')).not.toBe(kept);
    // Nothing of the old user is left to go back to.
    expect(telegram.setBackHandler).toHaveBeenLastCalledWith(null);
    await user.click(screen.getByRole('button', { name: ru.common.close }));
    expect(telegram.close).toHaveBeenCalledTimes(1);
  });

  it('a new user reaches the settings from the welcome screen', async () => {
    const { user } = setup();

    await user.click(await screen.findByRole('button', { name: ru.common.settings }));

    expect(heading()).toHaveTextContent(ru.settings.title);
    expect(await screen.findByRole('button', { name: ru.settings.deletion.open })).toBeInTheDocument();
  });
});

describe('App: consent to the processing of personal data', () => {
  it('asks for it right after the welcome screen, before any birth data, with the box empty', async () => {
    const { api, user } = setup();

    await openConsent(user);

    expect(heading()).toHaveTextContent(ru.consent.title);
    expect(heading()).toHaveFocus();
    expect(screen.getByText(ru.consent.lead)).toBeInTheDocument();
    for (const point of ru.consent.points) expect(screen.getByText(point)).toBeInTheDocument();
    expect(consentBox()).not.toBeChecked();
    expect(proceed()).toBeDisabled();
    expect(api.resolveGeo).not.toHaveBeenCalled();
    expect(api.createChart).not.toHaveBeenCalled();
  });

  it('lets the user on only while the box is ticked', async () => {
    const { user } = setup();
    await openConsent(user);

    await user.click(proceed());
    expect(heading()).toHaveTextContent(ru.consent.title);

    await user.click(consentBox());
    expect(consentBox()).toBeChecked();
    expect(proceed()).toBeEnabled();

    await user.click(consentBox());
    expect(consentBox()).not.toBeChecked();
    expect(proceed()).toBeDisabled();

    await user.click(consentBox());
    await user.click(proceed());
    expect(heading()).toHaveTextContent(ru.birthDate.title);
  });

  it('sends the consent and the version of its text with the chart request', async () => {
    const { api, user } = setup();

    await fillIn(user);

    await screen.findByRole('region', { name: ru.chart.sun });
    expect(api.createChart.mock.calls[0]?.[0].consent).toEqual({ accepted: true, version: CONSENT_VERSION });
  });

  it.each(['privacy', 'terms'] as const)('opens the %s document inside the app and comes back with the tick kept', async (name) => {
    const { telegram, user } = setup();
    await openConsent(user);
    await user.click(consentBox());

    await user.click(screen.getByRole('button', { name: ru.consent.documents[name] }));

    expect(heading()).toHaveTextContent(ru.consent.documents[name]);
    expect(heading()).toHaveFocus();
    for (const paragraph of ru.documents[name].paragraphs) expect(screen.getByText(paragraph)).toBeInTheDocument();
    expect(screen.getByText(ru.documents.version(CONSENT_VERSION))).toBeInTheDocument();

    act(() => {
      backHandler(telegram)?.();
    });

    expect(heading()).toHaveTextContent(ru.consent.title);
    expect(consentBox()).toBeChecked();
  });

  it('opening a document does not tick the box', async () => {
    const { telegram, user } = setup();
    await openConsent(user);

    await user.click(screen.getByRole('button', { name: ru.consent.documents.privacy }));
    act(() => {
      backHandler(telegram)?.();
    });

    expect(consentBox()).not.toBeChecked();
    expect(proceed()).toBeDisabled();
  });

  it('remembers the answer while the user moves between the screens', async () => {
    const { telegram, user } = setup();
    await enterDate(user);

    act(() => {
      backHandler(telegram)?.();
    });
    act(() => {
      backHandler(telegram)?.();
    });

    expect(heading()).toHaveTextContent(ru.consent.title);
    expect(consentBox()).toBeChecked();
  });

  it('opens the agreement straight from the welcome screen and comes back to it; reading is not consenting', async () => {
    const { api, telegram, user } = setup();
    await start();

    await user.click(termsLine());

    expect(heading()).toHaveTextContent(ru.consent.documents.terms);
    expect(heading()).toHaveFocus();
    for (const paragraph of ru.documents.terms.paragraphs) expect(screen.getByText(paragraph)).toBeInTheDocument();

    act(() => {
      backHandler(telegram)?.();
    });

    expect(heading()).toHaveTextContent(ru.welcome.title);
    expect(backHandler(telegram)).toBeNull();
    await openConsent(user);
    expect(consentBox()).not.toBeChecked();
    expect(api.createChart).not.toHaveBeenCalled();
  });

  describe('«Не сейчас»', () => {
    it('leads back to the welcome screen without a tick: asked again, the box is empty', async () => {
      const { api, telegram, user } = setup();
      await openConsent(user);
      await user.click(consentBox());
      expect(consentBox()).toBeChecked();

      await user.click(notNow());

      expect(heading()).toHaveTextContent(ru.welcome.title);
      expect(heading()).toHaveFocus();
      // The first screen again: nothing to go back to.
      expect(backHandler(telegram)).toBeNull();

      await openConsent(user);
      expect(consentBox()).not.toBeChecked();
      expect(proceed()).toBeDisabled();
      expect(api.resolveGeo).not.toHaveBeenCalled();
      expect(api.createChart).not.toHaveBeenCalled();
    });
  });
});

describe('App: from the welcome screen to the chart', () => {
  it('builds the chart from exactly what was entered', async () => {
    const { api, user } = setup();

    await enterDate(user);
    expect(heading()).toHaveTextContent(ru.birthTime.title);
    await enterTime(user, 'exact', '1430');
    expect(heading()).toHaveTextContent(ru.birthPlace.title);
    expect(api.createChart).not.toHaveBeenCalled();
    await enterPlace(user);

    expect(await screen.findByRole('region', { name: ru.chart.sun })).toBeInTheDocument();
    expect(heading()).toHaveTextContent(ru.chart.title);
    expect(api.createChart).toHaveBeenCalledTimes(1);
    expect(api.createChart.mock.calls[0]?.[0]).toEqual(chartRequest);
    expect(api.createChart.mock.calls[0]?.[0].birth_place).toBe(kazan);
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
  });

  it('sends no time at all when the user does not know it', async () => {
    const { api, user } = setup();

    await enterDate(user, '29022000');
    await enterTime(user, 'unknown');
    await enterPlace(user);

    await screen.findByRole('region', { name: ru.chart.sun });
    expect(api.createChart.mock.calls[0]?.[0]).toEqual({
      ...chartRequest,
      birth_date: '2000-02-29',
      birth_time: null,
      time_precision: 'unknown',
    });
  });

  it('does not send a time typed before the user switched to "I don\'t know"', async () => {
    const { api, user } = setup();

    await enterDate(user);
    await user.click(screen.getByRole('radio', { name: ru.birthTime.options.exact.title }));
    await user.keyboard('0905');
    await enterTime(user, 'unknown');
    await enterPlace(user);

    await screen.findByRole('region', { name: ru.chart.sun });
    expect(api.createChart.mock.calls[0]?.[0]).toMatchObject({ birth_time: null, time_precision: 'unknown' });
  });

  it('sends a roughly known time as approximate, and shows the server\'s warning about it on the chart', async () => {
    const approximate: ChartResult = {
      ...chartResult,
      chart: { ...chartResult.chart, birth: { ...chartResult.chart.birth, time: '09:05', time_precision: 'approximate' } },
      warnings: ['approximate_time'],
    };
    const { api, user } = setup({ api: (fake) => fake.createChart.mockResolvedValue(approximate) });

    await enterDate(user);
    await enterTime(user, 'approximate', '0905');
    await enterPlace(user);

    expect(await screen.findByText(ru.chart.warnings.approximate_time)).toBeInTheDocument();
    expect(api.createChart.mock.calls[0]?.[0]).toMatchObject({ birth_time: '09:05', time_precision: 'approximate' });
  });

  it('does not build the chart twice while the result is on screen', async () => {
    const { api, user } = setup();
    await enterDate(user);
    await enterTime(user, 'unknown');
    await enterPlace(user);
    await screen.findByRole('region', { name: ru.chart.sun });

    await user.click(screen.getByRole('button', { name: ru.chart.share }));
    await settleSearch();

    expect(api.createChart).toHaveBeenCalledTimes(1);
  });

  it('returns to the birth date with everything still filled in when the server rejects the data without naming a field', async () => {
    const { user } = setup({ api: (fake) => fake.createChart.mockRejectedValue(apiError('VALIDATION_FAILED', { status: 422 })) });
    await fillIn(user);

    await user.click(await screen.findByRole('button', { name: ru.chart.editData }));

    expect(heading()).toHaveTextContent(ru.birthDate.title);
    expect(screen.getByLabelText(ru.birthDate.day)).toHaveValue('17');
    expect(screen.getByLabelText(ru.birthDate.year)).toHaveValue('1994');

    await user.click(next());
    expect(screen.getByRole('radio', { name: ru.birthTime.options.exact.title })).toBeChecked();
    expect(screen.getByLabelText(ru.birthTime.hours)).toHaveValue('14');

    await user.click(next());
    expect(screen.getByLabelText(ru.birthPlace.label)).toHaveValue('Казань');
    expect(screen.getByText(ru.birthPlace.timezone('Europe/Moscow'))).toBeInTheDocument();
  });
});

describe('App: fields the server rejects', () => {
  const DATE = { field: 'birth_date', message: 'Сервис доступен с 18 лет' };
  const TIME = { field: 'birth_time', message: 'Укажи время рождения в формате ЧЧ:ММ или отметь, что не знаешь' };
  const PRECISION = { field: 'time_precision', message: 'Укажи, насколько точно известно время рождения' };
  const PLACE = { field: 'birth_place', message: 'Не знаем такой часовой пояс — выбери город заново' };
  const CONSENT = { field: 'consent', message: 'Без согласия на обработку данных мы не можем построить карту' };

  /** Fills everything in; the server rejects the first chart request with `fields` and accepts the next one. */
  async function rejectedOnce(...fields: { field: string; message: string }[]) {
    const view = setup({ api: (fake) => fake.createChart.mockRejectedValueOnce(rejection(...fields)) });
    await fillIn(view.user);
    await screen.findAllByRole('alert');
    return view;
  }

  it('brings the user to the date with the server text at the field and everything still filled in', async () => {
    await rejectedOnce(DATE);

    expect(heading()).toHaveTextContent(ru.birthDate.title);
    expect(screen.getByRole('alert')).toHaveTextContent(DATE.message);
    const day = screen.getByLabelText(ru.birthDate.day);
    expect(day).toHaveValue('17');
    expect(day).toHaveAttribute('aria-invalid', 'true');
    expect(day).toHaveFocus();
    expect(screen.getByLabelText(ru.birthDate.year)).toHaveValue('1994');
  });

  it('walks forward from there through the untouched answers and asks the server again', async () => {
    const { api, user } = await rejectedOnce(DATE);

    await user.click(next());
    expect(heading()).toHaveTextContent(ru.birthTime.title);
    expect(screen.getByRole('radio', { name: ru.birthTime.options.exact.title })).toBeChecked();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    await user.click(next());
    expect(heading()).toHaveTextContent(ru.birthPlace.title);
    expect(screen.getByText(ru.birthPlace.timezone('Europe/Moscow'))).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    await user.click(buildChart());

    expect(await screen.findByRole('region', { name: ru.chart.sun })).toBeInTheDocument();
    expect(api.createChart).toHaveBeenCalledTimes(2);
    expect(api.createChart.mock.calls[1]?.[0]).toEqual(chartRequest);
  });

  it('drops the server text as soon as the user changes the field it was about', async () => {
    const { user } = await rejectedOnce(DATE);

    await user.type(screen.getByLabelText(ru.birthDate.year), '{Backspace}3');

    expect(screen.getByLabelText(ru.birthDate.year)).toHaveValue('1993');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('leads Back from the rejected step the usual way: consent, then the welcome screen', async () => {
    const { telegram } = await rejectedOnce(DATE);

    act(() => {
      backHandler(telegram)?.();
    });
    expect(heading()).toHaveTextContent(ru.consent.title);
    expect(consentBox()).toBeChecked();

    act(() => {
      backHandler(telegram)?.();
    });
    expect(heading()).toHaveTextContent(ru.welcome.title);
    expect(backHandler(telegram)).toBeNull();
  });

  it('shows the text about the time at the time field', async () => {
    await rejectedOnce(TIME);

    expect(heading()).toHaveTextContent(ru.birthTime.title);
    expect(screen.getByRole('alert')).toHaveTextContent(TIME.message);
    expect(screen.getByLabelText(ru.birthTime.hours)).toHaveValue('14');
    expect(screen.getByLabelText(ru.birthTime.hours)).toHaveFocus();
  });

  it('drops the text about the time when the user edits the time', async () => {
    const { user } = await rejectedOnce(TIME);

    await user.type(screen.getByLabelText(ru.birthTime.minutes), '{Backspace}5');

    expect(screen.getByLabelText(ru.birthTime.minutes)).toHaveValue('35');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows the text about the precision at the options; another option answers both the precision and the time', async () => {
    const { user } = await rejectedOnce(PRECISION, TIME);

    expect(heading()).toHaveTextContent(ru.birthTime.title);
    expect(screen.getAllByRole('alert').map((alert) => alert.textContent)).toEqual([PRECISION.message, TIME.message]);
    expect(screen.getByRole('radio', { name: ru.birthTime.options.exact.title })).toHaveFocus();

    await user.click(screen.getByRole('radio', { name: ru.birthTime.options.unknown.title }));

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows the text about the place at the search field, with the place still on screen', async () => {
    const { user } = await rejectedOnce(PLACE);

    expect(heading()).toHaveTextContent(ru.birthPlace.title);
    expect(screen.getByRole('alert')).toHaveTextContent(PLACE.message);
    const field = screen.getByLabelText(ru.birthPlace.label);
    expect(field).toHaveValue('Казань');
    expect(field).toHaveFocus();
    expect(screen.getByText(ru.birthPlace.timezone('Europe/Moscow'))).toBeInTheDocument();

    await user.type(field, 'к');

    expect(screen.queryByText(PLACE.message)).not.toBeInTheDocument();
  });

  it('brings the user back to the consent screen when the consent is what the server rejected', async () => {
    const { telegram, user } = await rejectedOnce(CONSENT);

    expect(heading()).toHaveTextContent(ru.consent.title);
    expect(screen.getByRole('alert')).toHaveTextContent(CONSENT.message);
    expect(consentBox()).toHaveAttribute('aria-invalid', 'true');
    expect(consentBox()).toHaveAccessibleDescription(CONSENT.message);
    expect(consentBox()).toHaveFocus();

    // Answering again is the user acting on the text: it goes away.
    await user.click(consentBox());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(proceed()).toBeDisabled();

    act(() => {
      backHandler(telegram)?.();
    });
    expect(heading()).toHaveTextContent(ru.welcome.title);
  });

  it('starts at the earliest rejected step and shows the text of each later one when the user gets there', async () => {
    const { user } = await rejectedOnce(PLACE, DATE);

    expect(heading()).toHaveTextContent(ru.birthDate.title);
    expect(screen.getByRole('alert')).toHaveTextContent(DATE.message);

    await user.click(next());
    expect(heading()).toHaveTextContent(ru.birthTime.title);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    await user.click(next());
    expect(heading()).toHaveTextContent(ru.birthPlace.title);
    expect(screen.getByRole('alert')).toHaveTextContent(PLACE.message);
  });

  it('shows the first text when the server names a field twice', async () => {
    await rejectedOnce(PLACE, { field: 'birth_place', message: 'Код страны — две заглавные буквы (RU, KZ)' });

    expect(screen.getByRole('alert')).toHaveTextContent(PLACE.message);
    expect(screen.queryByText(/Код страны/)).not.toBeInTheDocument();
  });

  it('forgets the old verdict once a new request is sent', async () => {
    const { telegram, user } = await rejectedOnce(PLACE);

    await user.click(buildChart());
    await screen.findByRole('region', { name: ru.chart.sun });
    act(() => {
      backHandler(telegram)?.();
    });

    expect(heading()).toHaveTextContent(ru.birthPlace.title);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('stays on the chart screen with the server text when the field belongs to no screen', async () => {
    await rejectedOnce({ field: 'body', message: 'Проверь это поле' });

    expect(heading()).toHaveTextContent(ru.chart.title);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(ru.errors.VALIDATION_FAILED.title);
    expect(alert).toHaveTextContent('Проверь это поле');
    expect(screen.getByRole('button', { name: ru.chart.editData })).toBeInTheDocument();
  });

  it('does not move a user who has already left the chart screen when the rejection arrives', async () => {
    const pending = deferred<ChartResult>();
    const { telegram, user } = setup({ api: (fake) => fake.createChart.mockImplementation(() => pending.promise) });
    await fillIn(user);
    act(() => {
      backHandler(telegram)?.();
    });
    expect(heading()).toHaveTextContent(ru.birthPlace.title);

    await act(async () => {
      pending.reject(rejection(DATE));
      await pending.promise.catch(() => undefined);
    });

    expect(heading()).toHaveTextContent(ru.birthPlace.title);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('App: the server refuses the version of the consent', () => {
  const VERSION = { field: 'consent.version', message: 'Условия обновились — подтверди согласие ещё раз' };
  const DATE = { field: 'birth_date', message: 'Сервис доступен с 18 лет' };
  /** What the task asks the user to see after the restart, letter for letter. */
  const RENEWED = 'Условия обновились, подтверди ещё раз.';
  /** A version older than the one of this build: the build before the restart had it. */
  const OLDER_VERSION = '2026-01-01';

  /** Fills everything in; the server refuses the chart request because of `fields`. */
  async function refused(options: SetupOptions = {}, ...fields: { field: string; message: string }[]) {
    const view = setup({ ...options, api: (fake) => fake.createChart.mockRejectedValue(rejection(...fields)) });
    await fillIn(view.user);
    return view;
  }

  describe('in the build that was refused', () => {
    it('notes the refused version, then restarts the app: newer texts come only with a newer build', async () => {
      const { termsReload } = await refused({}, VERSION);

      await waitFor(() => {
        expect(termsReload.reload).toHaveBeenCalledTimes(1);
      });
      expect(termsReload.remember).toHaveBeenCalledTimes(1);
      expect(termsReload.remember).toHaveBeenCalledWith(CONSENT_VERSION);
      expect(termsReload.remember.mock.invocationCallOrder[0]).toBeLessThan(termsReload.reload.mock.invocationCallOrder[0] ?? 0);
    });

    it('restarts even when the server names other fields too: nothing can be corrected under outdated texts', async () => {
      const { termsReload } = await refused({}, DATE, VERSION);

      await waitFor(() => {
        expect(termsReload.reload).toHaveBeenCalledTimes(1);
      });
      expect(screen.queryByText(DATE.message)).not.toBeInTheDocument();
      expect(screen.queryByText(ru.birthDate.title)).not.toBeInTheDocument();
    });

    describe('where the browser keeps nothing between page loads', () => {
      it('says what happened instead of restarting without a word, and leaves the restart to the user', async () => {
        const { termsReload, user } = await refused({ termsReload: { storage: false } }, VERSION);

        const alert = await screen.findByRole('alert');
        expect(alert).toHaveTextContent(ru.termsUpdate.outdatedTitle);
        expect(alert).toHaveTextContent(ru.termsUpdate.outdatedText);
        expect(termsReload.reload).not.toHaveBeenCalled();

        await user.click(screen.getByRole('button', { name: ru.termsUpdate.reload }));

        expect(termsReload.reload).toHaveBeenCalledTimes(1);
        expect(screen.getByRole('main')).toHaveAttribute('aria-busy', 'true');
      });
    });
  });

  describe('in the build that starts after the restart, with newer texts', () => {
    const afterRestart = (options: SetupOptions = {}) => setup({ ...options, termsReload: { refusedVersion: OLDER_VERSION } });

    it('opens on the consent screen with an empty box and says why the user is here again', async () => {
      const { api, termsReload } = afterRestart();

      expect(await screen.findByRole('heading', { level: 1, name: ru.consent.title })).toHaveFocus();
      const notice = screen.getByRole('note');
      expect(notice).toHaveTextContent(RENEWED);
      expect(notice).toHaveTextContent(ru.termsUpdate.renewed);
      expect(heading()).toHaveAccessibleDescription(ru.termsUpdate.renewed);
      expect(consentBox()).not.toBeChecked();
      expect(proceed()).toBeDisabled();
      // One restart is enough.
      expect(termsReload.reload).not.toHaveBeenCalled();
      expect(api.createChart).not.toHaveBeenCalled();
    });
  });

  describe('in the build that starts after the restart, with the same texts', () => {
    const stillOutdated = (options: SetupOptions = {}) => setup({ ...options, termsReload: { refusedVersion: CONSENT_VERSION } });

    it('says that the new version has not arrived, and asks for no data it could not use', async () => {
      const { api, termsReload } = stillOutdated();

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent(ru.termsUpdate.outdatedTitle);
      expect(alert).toHaveTextContent(ru.termsUpdate.outdatedText);
      expect(screen.queryByRole('button', { name: ru.welcome.start })).not.toBeInTheDocument();
      expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
      // No second restart on its own: that would be a loop.
      expect(termsReload.reload).not.toHaveBeenCalled();
      expect(api.createChart).not.toHaveBeenCalled();
    });

    it('restarts when the user asks, noting the version again so that the next start knows', async () => {
      const { termsReload, user } = stillOutdated();

      await user.click(await screen.findByRole('button', { name: ru.termsUpdate.reload }));

      expect(termsReload.remember).toHaveBeenCalledWith(CONSENT_VERSION);
      expect(termsReload.reload).toHaveBeenCalledTimes(1);
      expect(screen.getByRole('status')).toHaveTextContent(ru.common.loading);
    });
  });
});

describe('App: product events', () => {
  it('reports the way from the first screen to the chart, step by step', async () => {
    const { analytics, user } = setup();

    await fillIn(user);
    await user.click(await screen.findByRole('button', { name: ru.chart.share }));

    expect(analytics.events).toEqual([
      { name: 'app_open' },
      { name: 'screen_view', props: { step: 'welcome' } },
      { name: 'screen_view', props: { step: 'consent' } },
      { name: 'consent_view' },
      { name: 'consent_accepted', props: { version: CONSENT_VERSION } },
      { name: 'screen_view', props: { step: 'birth_date' } },
      { name: 'birth_date_done' },
      { name: 'screen_view', props: { step: 'birth_time' } },
      { name: 'birth_time_done' },
      { name: 'screen_view', props: { step: 'birth_place' } },
      { name: 'place_search' },
      { name: 'birth_place_done' },
      { name: 'screen_view', props: { step: 'chart' } },
      { name: 'chart_requested' },
      { name: 'chart_created' },
      { name: 'share_clicked' },
    ]);
  });

  it('reports every step back by the screen that was left, whichever control took the user there', async () => {
    const { analytics, telegram, user } = setup({ api: (fake) => fake.createChart.mockRejectedValue(apiError('VALIDATION_FAILED', { status: 422 })) });
    await fillIn(user);
    await screen.findByRole('alert');
    analytics.clear();

    // «Изменить данные» on the chart screen, then Telegram's Back twice, then «Не сейчас».
    await user.click(screen.getByRole('button', { name: ru.chart.editData }));
    act(() => {
      backHandler(telegram)?.();
    });
    await user.click(notNow());

    expect(analytics.events).toEqual([
      { name: 'step_back', props: { step: 'chart' } },
      { name: 'screen_view', props: { step: 'birth_date' } },
      { name: 'step_back', props: { step: 'birth_date' } },
      { name: 'screen_view', props: { step: 'consent' } },
      { name: 'consent_view' },
      { name: 'step_back', props: { step: 'consent' } },
      { name: 'screen_view', props: { step: 'welcome' } },
    ]);
  });

  describe('carry nothing the user entered', () => {
    /** Everything the user types or picks in these tests, and everything the chart says back. */
    const ENTERED = [
      '1994',
      '05-17',
      '17.05',
      '1705',
      '14:30',
      '1430',
      'Каз',
      'Казань',
      'Татарстан',
      '55.79',
      '49.1',
      'Europe',
      'Moscow',
      chartResult.chart.chart_id,
      'sig=',
    ];
    /** The only properties an event may have, and what each may hold. */
    const ALLOWED: Record<string, (value: unknown) => boolean> = {
      step: (value) => ['welcome', 'consent', 'privacy', 'terms', 'birth_date', 'birth_time', 'birth_place', 'chart'].includes(String(value)),
      code: (value) => /^[A-Z_]+$/.test(String(value)),
      field: (value) => /^[a-z_.]+$/.test(String(value)),
      version: (value) => value === CONSENT_VERSION,
    };

    /** A pass with a server rejection, a failed search and steps back in it: every kind of event the app has. */
    async function eventfulPass(view: ReturnType<typeof setup>) {
      const { api, telegram, user } = view;
      api.createChart
        .mockRejectedValueOnce(
          rejection(
            { field: 'birth_place', message: 'Не знаем такой часовой пояс — выбери город заново' },
            { field: 'birth_place.tz', message: 'Europe/Moscow' },
          ),
        )
        .mockResolvedValueOnce(chartResult);
      api.resolveGeo
        .mockResolvedValueOnce([kazan])
        .mockResolvedValueOnce([])
        .mockRejectedValueOnce(rejection({ field: 'query', message: 'Слишком длинный запрос — введи название города' }))
        .mockResolvedValue([kazan]);

      await fillIn(user);
      await screen.findAllByRole('alert');
      // Back on the place screen with the server's text: search again, three ways.
      const field = screen.getByLabelText(ru.birthPlace.label);
      await user.type(field, 'ск');
      await settleSearch();
      await user.type(field, 'ий');
      await settleSearch();
      await user.clear(field);
      await user.type(field, 'Казань');
      await settleSearch();
      await user.click(screen.getByRole('button', { name: /Казань/ }));
      act(() => {
        backHandler(telegram)?.();
      });
      await user.click(next());
      await user.click(buildChart());
      await user.click(await screen.findByRole('button', { name: ru.chart.share }));
    }

    it('in what goes to the server: the bodies of POST /events', async () => {
      const api = fakeApi();
      const sent = createAnalytics({ api, isEnabled: () => true, now: () => TODAY });
      const telegram = fakeTelegram();
      const user = setupUser();
      render(
        <App
          api={api}
          telegram={telegram}
          apiBaseUrl="https://api.test"
          keys={fakeKeys()}
          track={sent.track}
          termsReload={fakeTermsReload()}
          today={TODAY}
        />,
      );
      await eventfulPass({ api, telegram, user } as ReturnType<typeof setup>);
      act(() => {
        sent.flush();
      });

      const batches = api.sendEvents.mock.calls.map(([events]) => events);
      const events = batches.flat();
      expect(events.length).toBeGreaterThan(20);
      for (const batch of batches) expect(batch.length).toBeLessThanOrEqual(20);
      for (const event of events) {
        expect(Object.keys(event).sort()).toEqual(event.props ? ['name', 'occurred_at', 'props'] : ['name', 'occurred_at']);
        expect(event.occurred_at).toBe(TODAY.toISOString());
        for (const [key, value] of Object.entries(event.props ?? {})) {
          expect(ALLOWED[key]?.(value), `${event.name}: ${key}=${String(value)}`).toBe(true);
        }
      }
      const body = JSON.stringify(batches);
      expect(body).not.toMatch(/\p{Script=Cyrillic}/u);
      for (const secret of ENTERED) expect(body).not.toContain(secret);
    });
  });
});

describe('App: going back', () => {
  it('drives Telegram\'s Back button: off on the first screen, on from the second', async () => {
    const { telegram, user } = setup();
    await start();
    expect(backHandler(telegram)).toBeNull();

    await enterDate(user);
    expect(heading()).toHaveTextContent(ru.birthTime.title);
    const goBack = backHandler(telegram);
    expect(goBack).toBeInstanceOf(Function);

    act(() => {
      goBack?.();
    });

    expect(heading()).toHaveTextContent(ru.birthDate.title);
    expect(screen.getByLabelText(ru.birthDate.day)).toHaveValue('17');
    expect(screen.getByLabelText(ru.birthDate.month)).toHaveValue('05');
    expect(screen.getByLabelText(ru.birthDate.year)).toHaveValue('1994');
    // Nothing is left to type in a finished date, so the title is what gets announced.
    expect(heading()).toHaveFocus();

    act(() => {
      backHandler(telegram)?.();
    });
    expect(heading()).toHaveTextContent(ru.consent.title);

    act(() => {
      backHandler(telegram)?.();
    });

    expect(heading()).toHaveTextContent(ru.welcome.title);
    expect(backHandler(telegram)).toBeNull();
  });

  it('shows no Back control of its own while Telegram provides one', async () => {
    const { user } = setup();
    await enterDate(user);
    expect(screen.queryByRole('button', { name: ru.common.back })).not.toBeInTheDocument();
  });

  it('draws its own Back control where Telegram has none', async () => {
    const { user } = setup({ telegram: { hasNativeBackButton: false } });
    await start();
    expect(screen.queryByRole('button', { name: ru.common.back })).not.toBeInTheDocument();

    await openConsent(user);
    expect(heading()).toHaveTextContent(ru.consent.title);
    await user.click(screen.getByRole('button', { name: ru.consent.documents.terms }));
    expect(heading()).toHaveTextContent(ru.consent.documents.terms);

    await user.click(screen.getByRole('button', { name: ru.common.back }));
    expect(heading()).toHaveTextContent(ru.consent.title);

    await user.click(screen.getByRole('button', { name: ru.common.back }));

    expect(heading()).toHaveTextContent(ru.welcome.title);
    expect(screen.queryByRole('button', { name: ru.common.back })).not.toBeInTheDocument();
  });

  it('goes back from the chart to the place, which is still chosen', async () => {
    const { api, telegram, user } = setup();
    await enterDate(user);
    await enterTime(user, 'unknown');
    await enterPlace(user);
    await screen.findByRole('region', { name: ru.chart.sun });

    act(() => {
      backHandler(telegram)?.();
    });

    expect(heading()).toHaveTextContent(ru.birthPlace.title);
    expect(screen.getByText(ru.birthPlace.timezone('Europe/Moscow'))).toBeInTheDocument();
    expect(api.resolveGeo).toHaveBeenCalledTimes(1);
  });

  it('releases the Back button when the app goes away', async () => {
    const { telegram, user, unmount } = setup();
    await enterDate(user);
    expect(backHandler(telegram)).not.toBeNull();

    unmount();

    expect(backHandler(telegram)).toBeNull();
  });
});

describe('App: the forecast and the question', () => {
  const restored: ChartResult = { ...chartResult, is_restored: true };
  const chartId = chartResult.chart.chart_id;
  /** A user without a subscription: one question a day, none asked yet. */
  const meFree = meAsking({ used: 0, limit: 1 }, meWithChart);
  /** The texts of apps/api about a chart it does not have. */
  const CHART_GONE = 'Такой карты нет. Построй карту заново';
  const chartGone = () => apiError('NOT_FOUND', { status: 404, serverMessage: CHART_GONE, requestId: 'req-404' });

  interface RetentionOptions {
    /** Whether the build sells subscriptions (`VITE_SUBSCRIPTIONS=enabled`). The tests here are about one that does, unless they say otherwise. */
    subscriptions?: boolean;
    prepare?: (fake: ReturnType<typeof fakeApi>) => void;
  }

  /** A user who has a chart, in a build that sells subscriptions or does not; `prepare` sets up the rest of the server. */
  function returning(startMe: Me, { subscriptions = true, prepare }: RetentionOptions = {}) {
    const api = fakeApi();
    api.getMe.mockResolvedValue(startMe);
    api.getCurrentChart.mockResolvedValue(restored);
    api.getForecast.mockResolvedValue(forecast);
    prepare?.(api);
    const telegram = fakeTelegram();
    const analytics = fakeAnalytics();
    const keys = fakeKeys();
    const forgetKeys = vi.spyOn(keys, 'forgetAll');
    const user = setupUser();
    const view = render(
      <App
        api={api}
        telegram={telegram}
        apiBaseUrl="https://api.test"
        keys={keys}
        track={analytics.track}
        termsReload={fakeTermsReload()}
        today={TODAY}
        subscriptions={subscriptions}
      />,
    );
    return { api, telegram, analytics, keys, forgetKeys, user, ...view };
  }

  const forecastCard = () => screen.findByRole('button', { name: /^Прогноз на / });
  const askButton = () => screen.findByRole('button', { name: ru.forecast.ask });
  const questionField = () => screen.getByRole('textbox', { name: ru.ask.fieldLabel });
  const sendButton = () => screen.getByRole('button', { name: ru.ask.submit });
  const settle = () => act(async () => {});

  async function openForecast(user: FakeUser) {
    await user.click(await forecastCard());
    await settle();
  }
  async function openAsk(user: FakeUser) {
    await openForecast(user);
    await user.click(await askButton());
    await settle();
  }
  async function sendQuestion(user: FakeUser, text = 'На что опереться в работе?') {
    await user.type(questionField(), text);
    await user.click(sendButton());
    await settle();
  }

  it('from the card on the chart to the forecast, and on to a question and its answer', async () => {
    const { api, analytics, telegram, user } = returning(meAsking());

    // On the chart: the name of the forecast and its first sentence, in one card.
    const card = await forecastCard();
    expect(card).toHaveTextContent('Прогноз на сегодня');
    await waitFor(() => {
      expect(card).toHaveTextContent('Первое предложение прогноза.');
    });
    expect(card).not.toHaveTextContent('Второе предложение');
    expect(api.getForecast).toHaveBeenCalledTimes(1);
    expect(api.getForecast.mock.calls[0]?.[0]).toBe(chartId);
    analytics.clear();

    await user.click(card);
    expect(heading()).toHaveTextContent('Прогноз на сегодня');
    // The whole text is there from the first frame: the card has heard it already.
    expect(screen.getByText(forecast.text)).toBeInTheDocument();
    expect(screen.getByText('Фокус дня: карьера')).toBeInTheDocument();
    expect(backHandler(telegram)).not.toBeNull();
    await settle();
    // One more question to the server for the opening of the screen, and no other.
    expect(api.getForecast).toHaveBeenCalledTimes(2);
    // Both belong to the same moment: the screen opened with the forecast already on it.
    expect(analytics.events).toHaveLength(2);
    expect(analytics.events).toContainEqual({ name: 'screen_view', props: { step: 'forecast' } });
    expect(analytics.events).toContainEqual({ name: 'forecast_view' });

    await user.click(await askButton());
    await settle();
    expect(heading()).toHaveTextContent('Спроси карту');
    expect(screen.getByText('Сегодня осталось 3 вопроса из 5')).toBeInTheDocument();

    // The server counts the question, and the screen shows what the server says after it.
    api.getMe.mockResolvedValue(meAsking({ used: 3 }));
    await sendQuestion(user);

    expect(api.ask).toHaveBeenCalledTimes(1);
    expect(api.ask).toHaveBeenCalledWith({ chart_id: chartId, question: 'На что опереться в работе?' }, expect.any(AbortSignal));
    expect(screen.getByText(askAnswer.answer)).toBeInTheDocument();
    expect(screen.getByText('Сегодня осталось 2 вопроса из 5')).toBeInTheDocument();
    expect(analytics.events.slice(2)).toEqual([{ name: 'screen_view', props: { step: 'ask' } }, { name: 'ask_used' }]);

    // Back leads to the forecast, then to the chart, each named by its own step.
    analytics.clear();
    act(() => backHandler(telegram)?.());
    expect(heading()).toHaveTextContent('Прогноз на сегодня');
    act(() => backHandler(telegram)?.());
    expect(await screen.findByRole('region', { name: ru.chart.sun })).toBeInTheDocument();
    expect(analytics.events.filter(({ name }) => name === 'step_back')).toEqual([
      { name: 'step_back', props: { step: 'ask' } },
      { name: 'step_back', props: { step: 'forecast' } },
    ]);
    // The chart was kept: the way back asked the server for no chart.
    expect(api.getCurrentChart).toHaveBeenCalledTimes(1);
  });

  it('shows the card on a chart just built from the form as well, for the chart the server made', async () => {
    const api = fakeApi();
    // A new user at the start; once the chart is built, `Me` names it.
    api.getMe.mockResolvedValueOnce(me).mockResolvedValue(meWithChart);
    // A chart of this minute has no forecast yet: the server prepares one overnight.
    api.getForecast.mockResolvedValue(null);
    const analytics = fakeAnalytics();
    const user = setupUser();
    render(
      <App api={api} telegram={fakeTelegram()} apiBaseUrl="https://api.test" keys={fakeKeys()} track={analytics.track} termsReload={fakeTermsReload()} today={TODAY} />,
    );
    await fillIn(user);

    const card = await forecastCard();
    await waitFor(() => {
      expect(card).toHaveTextContent('Сегодняшний прогноз готовится. Загляни после 08:00');
    });
    expect(api.getForecast).toHaveBeenCalledTimes(1);
    expect(api.getForecast.mock.calls[0]?.[0]).toBe(chartId);

    await user.click(card);
    expect(await screen.findByRole('heading', { name: 'Сегодняшний прогноз готовится' })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'К карте' }));
    expect(await screen.findByRole('region', { name: ru.chart.sun })).toBeInTheDocument();
    // The chart was built once.
    expect(api.createChart).toHaveBeenCalledTimes(1);
  });

  describe('the way to a subscription', () => {
    it('under the short forecast: a quiet note that leads to the paywall with the subscriptions', async () => {
      const { api, analytics, user } = returning(meFree, { prepare: (fake) => fake.getForecast.mockResolvedValue(freeForecast) });
      await openForecast(user);

      expect(screen.getByText(freeForecast.text)).toBeInTheDocument();
      analytics.clear();
      await user.click(screen.getByRole('button', { name: 'Полный прогноз — в подписке' }));

      expect(heading()).toHaveTextContent(ru.paywall.title);
      // The subscriptions alone: the note was not about the report.
      expect(screen.getAllByRole('radio')).toHaveLength(3);
      expect(screen.getAllByRole('radio').some((radio) => (radio as HTMLInputElement).checked)).toBe(false);
      expect(analytics.names()).toEqual(['screen_view', 'paywall_view']);
      expect(api.createInvoice).not.toHaveBeenCalled();
    });

    it('where the day\'s questions are used up: «В подписке 5 вопросов в день» leads to the same paywall', async () => {
      const { user } = returning(meAsking({ used: 1, limit: 1 }, meWithChart));
      await openAsk(user);

      expect(screen.getByText('Вопросы на сегодня закончились. Новые — после полуночи.')).toBeInTheDocument();
      expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'В подписке 5 вопросов в день' }));
      expect(heading()).toHaveTextContent(ru.paywall.title);
      expect(screen.getAllByRole('radio')).toHaveLength(3);
    });

    it('is not shown to a subscriber: not under a short forecast, not where the questions are used up', async () => {
      const { user } = returning(meAsking({ used: 5 }), { prepare: (fake) => fake.getForecast.mockResolvedValue(freeForecast) });
      await openForecast(user);
      expect(screen.getByText(freeForecast.text)).toBeInTheDocument();
      expect(screen.queryByText(ru.forecast.subscriptionOnly)).not.toBeInTheDocument();

      await user.click(await askButton());
      await settle();
      expect(screen.getByText(ru.ask.exhausted)).toBeInTheDocument();
      expect(screen.queryByText(ru.ask.subscriptionOffer)).not.toBeInTheDocument();
    });
  });

  describe('a build that sells no subscriptions (`subscriptions: false`)', () => {
    const off = { subscriptions: false } as const;

    it('offers none anywhere: the forecast, the used-up questions, the settings and the paywall say nothing of buying one', async () => {
      const { api, telegram, user } = returning(meAsking({ used: 1, limit: 1 }, meWithChart), {
        ...off,
        prepare: (fake) => fake.getForecast.mockResolvedValue(freeForecast),
      });

      // The short forecast: the text, and no note under it.
      await openForecast(user);
      expect(screen.getByText(freeForecast.text)).toBeInTheDocument();
      expect(screen.queryByText(ru.forecast.subscriptionOnly)).not.toBeInTheDocument();
      expect(screen.getByRole('main')).not.toHaveTextContent(/подписк/i);

      // The questions are used up: said calmly, with no offer.
      await user.click(await askButton());
      await settle();
      expect(screen.getByText(ru.ask.exhausted)).toBeInTheDocument();
      expect(screen.queryByText(ru.ask.subscriptionOffer)).not.toBeInTheDocument();
      expect(screen.getByRole('main')).not.toHaveTextContent(/подписк/i);

      // The settings: that there is no subscription is a fact and is said; the button to get one is not there.
      act(() => backHandler(telegram)?.());
      act(() => backHandler(telegram)?.());
      await user.click(await screen.findByRole('button', { name: ru.common.settings }));
      expect(await screen.findByText(ru.settings.subscription.none)).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: ru.settings.subscription.subscribe })).not.toBeInTheDocument();

      // The paywall, reached for the report: the report alone.
      act(() => backHandler(telegram)?.());
      await user.click(await screen.findByRole('button', { name: new RegExp(`^${ru.chart.teaserCta} `) }));
      expect(heading()).toHaveTextContent(ru.paywall.title);
      expect(screen.getAllByRole('radio')).toHaveLength(1);
      for (const code of ['week_149', 'month_399', 'year_2990'] as const) {
        expect(screen.queryByText(ru.paywall.plans[code].title)).not.toBeInTheDocument();
      }
      expect(api.createInvoice).not.toHaveBeenCalled();
    });

    it('still sells the report: the invoice asked for is the report\'s, for this chart', async () => {
      const { api, user } = returning(meWithChart, {
        ...off,
        prepare: (fake) => fake.getMe.mockResolvedValueOnce(meWithChart).mockResolvedValue(mePaid),
      });

      await user.click(await screen.findByRole('button', { name: new RegExp(`^${ru.chart.teaserCta} `) }));
      await user.click(await screen.findByRole('button', { name: new RegExp(`^${ru.paywall.pay} `) }));

      expect(await screen.findByRole('heading', { level: 1, name: ru.report.queuedTitle })).toBeInTheDocument();
      expect(api.createInvoice).toHaveBeenCalledTimes(1);
      expect(api.createInvoice).toHaveBeenCalledWith({ plan_code: 'one_149', chart_id: chartId }, expect.any(AbortSignal));
    });

    it('shows a subscriber what they have as ever: the full forecast, five questions, the plan in the settings', async () => {
      const { telegram, user } = returning(meAsking(), off);
      await openAsk(user);
      expect(screen.getByText('Сегодня осталось 3 вопроса из 5')).toBeInTheDocument();

      act(() => backHandler(telegram)?.());
      act(() => backHandler(telegram)?.());
      await user.click(await screen.findByRole('button', { name: ru.common.settings }));
      expect(await screen.findByText(ru.settings.subscription.names.month)).toBeInTheDocument();
    });
  });

  describe('the chart is gone from the server (the data was deleted elsewhere while this page stayed open)', () => {
    /** `Me` after the deletion: a user with nothing. */
    const meDeleted: Me = { ...me, is_new: false };

    /** The server from the moment of the deletion on: no chart, and a user without one. */
    function deleteElsewhere(api: ReturnType<typeof fakeApi>) {
      api.getMe.mockResolvedValue(meDeleted);
      api.getCurrentChart.mockResolvedValue(null);
    }

    /** What must hold however the app found out. */
    async function expectFreshStart(view: ReturnType<typeof returning>) {
      expect(await start()).toBeInTheDocument();
      expect(heading()).toHaveTextContent(ru.welcome.title);
      // Not a word of the server's about the chart, and nothing shown as a failure.
      expect(screen.queryByText(CHART_GONE)).not.toBeInTheDocument();
      expect(screen.queryByText(/Построй карту заново|Карта не найдена/)).not.toBeInTheDocument();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(view.analytics.names()).not.toContain('error_shown');
      // The first screen again: nothing to go back to, and the keys of the old chart's orders are dropped.
      expect(view.telegram.setBackHandler).toHaveBeenLastCalledWith(null);
      expect(view.forgetKeys).toHaveBeenCalled();
      // The form starts clean: the consent went with the data it was given for.
      await view.user.click(await start());
      expect(consentBox()).not.toBeChecked();
    }

    it('404 to a question: the welcome screen, as for a new user', async () => {
      const view = returning(meAsking(), { prepare: (fake) => fake.ask.mockRejectedValue(chartGone()) });
      await openAsk(view.user);

      deleteElsewhere(view.api);
      await sendQuestion(view.user);

      await expectFreshStart(view);
      expect(view.api.ask).toHaveBeenCalledTimes(1);
      // Asked which chart the user has, as at a start: the one at launch and the one now.
      expect(view.api.getCurrentChart).toHaveBeenCalledTimes(2);
    });

    it('404 to the order of a report: the same', async () => {
      const view = returning(mePaid, { prepare: (fake) => fake.orderReport.mockRejectedValue(chartGone()) });
      const order = await screen.findByRole('button', { name: ru.chart.orderReport });

      deleteElsewhere(view.api);
      await view.user.click(order);

      await expectFreshStart(view);
      expect(view.api.orderReport).toHaveBeenCalledTimes(1);
    });

    it('422 about `chart_id` to an invoice for the report: the same', async () => {
      const view = returning(meWithChart, {
        prepare: (fake) => fake.createInvoice.mockRejectedValue(rejection({ field: 'chart_id', message: 'Карта не найдена' })),
      });
      await view.user.click(await screen.findByRole('button', { name: new RegExp(`^${ru.chart.teaserCta} `) }));

      deleteElsewhere(view.api);
      await view.user.click(await screen.findByRole('button', { name: new RegExp(`^${ru.paywall.pay} `) }));

      await expectFreshStart(view);
      expect(view.telegram.openInvoice).not.toHaveBeenCalled();
    });

    it('404 to a forecast, and `Me` with no chart: the same. The 404 alone says «none yet», `Me` says which it is', async () => {
      const view = returning(meAsking());
      const card = await forecastCard();
      await waitFor(() => {
        expect(card).toHaveTextContent('Первое предложение прогноза.');
      });

      view.api.getForecast.mockResolvedValue(null);
      deleteElsewhere(view.api);
      await view.user.click(card);

      await expectFreshStart(view);
      expect(screen.queryByText(ru.forecast.pendingTitle)).not.toBeInTheDocument();
    });

    it('404 to a forecast while `Me` still names the chart: «готовится» and nothing else. One question to `Me`, no more', async () => {
      const view = returning(meAsking(), { prepare: (fake) => fake.getForecast.mockResolvedValue(null) });
      await openForecast(view.user);

      expect(screen.getByRole('heading', { name: 'Сегодняшний прогноз готовится' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: ru.welcome.start })).not.toBeInTheDocument();
      // `Me` at the start, and once for this «none yet».
      expect(view.api.getMe).toHaveBeenCalledTimes(2);
      expect(view.forgetKeys).not.toHaveBeenCalled();

      // And it stays one, however long the screen is open.
      await act(() => vi.advanceTimersByTimeAsync(10 * 60_000));
      expect(view.api.getMe).toHaveBeenCalledTimes(2);
      expect(view.api.getForecast).toHaveBeenCalledTimes(2);
    });

    it('the question screen opened after the deletion: `Me` says there is no chart, and no question is ever sent', async () => {
      const view = returning(meAsking());
      await openForecast(view.user);

      deleteElsewhere(view.api);
      await view.user.click(await askButton());

      await expectFreshStart(view);
      expect(view.api.ask).not.toHaveBeenCalled();
    });

    it('a chart built in this session goes: what the user typed into the form is not kept either, and the consent is asked anew', async () => {
      const api = fakeApi();
      api.getMe.mockResolvedValueOnce(me).mockResolvedValue(meWithChart);
      api.createInvoice.mockRejectedValue(rejection({ field: 'chart_id', message: 'Карта не найдена' }));
      const user = setupUser();
      render(
        <App api={api} telegram={fakeTelegram()} apiBaseUrl="https://api.test" keys={fakeKeys()} track={vi.fn()} termsReload={fakeTermsReload()} today={TODAY} />,
      );
      // The whole form, with the consent given, and the chart built from it.
      await fillIn(user);
      await user.click(await screen.findByRole('button', { name: new RegExp(`^${ru.chart.teaserCta} `) }));

      deleteElsewhere(api);
      await user.click(await screen.findByRole('button', { name: new RegExp(`^${ru.paywall.pay} `) }));

      // The welcome screen, and behind it a form as empty as a new user's.
      await user.click(await start());
      expect(heading()).toHaveTextContent(ru.consent.title);
      expect(consentBox()).not.toBeChecked();
      await user.click(consentBox());
      await user.click(proceed());
      expect(heading()).toHaveTextContent(ru.birthDate.title);
      expect(screen.getByLabelText(ru.birthDate.day)).toHaveValue('');
      expect(screen.getByLabelText(ru.birthDate.year)).toHaveValue('');
      expect(screen.queryByText('Карта не найдена')).not.toBeInTheDocument();
      // One chart was built, and none is built again by itself.
      expect(api.createChart).toHaveBeenCalledTimes(1);
    });

    it('a failure to ask `Me` is not «no chart»: the screens stay where they are', async () => {
      const view = returning(meAsking(), { prepare: (fake) => fake.getForecast.mockResolvedValue(null) });
      await forecastCard();
      view.api.getMe.mockRejectedValue(apiError('NETWORK'));
      await openForecast(view.user);

      expect(screen.getByRole('heading', { name: 'Сегодняшний прогноз готовится' })).toBeInTheDocument();
      expect(view.forgetKeys).not.toHaveBeenCalled();
    });
  });

  it('reports nothing of the forecast, the question or the answer', async () => {
    const { analytics, user } = returning(meAsking());
    await openAsk(user);
    await sendQuestion(user, 'Вопрос про работу и деньги?');

    expect([...analytics.names()].sort()).toEqual(
      ['app_open', 'screen_view', 'chart_restored', 'screen_view', 'forecast_view', 'screen_view', 'ask_used'].sort(),
    );
    expect(JSON.stringify(analytics.events)).not.toMatch(/[А-Яа-яЁё]/);
  });
});

describe('App: the full report is paid for a chart, not for the user (`Entitlements.full_report_chart_id`)', () => {
  const CHART_A = chartResult.chart.chart_id;
  const CHART_B = '00000000-0000-4000-8000-0000000000b0';
  const chartA: ChartResult = { ...chartResult, is_restored: true };
  const chartB: ChartResult = { ...chartResult, chart: { ...chartResult.chart, chart_id: CHART_B }, is_restored: true };
  /** The report of chart A, ready: the one `Me` names as the user's latest. */
  const reportOfA = { ...report, chart_id: CHART_A, status: 'ready' as const, progress: 100, sections };

  /** `Me` of a user whose current chart is `chartId`; what the server says of the report is `paidFor`. */
  const meOn = (chartId: string, paidFor: string | null, extra: Partial<Me> = {}): Me => ({
    ...meWithChart,
    chart_id: chartId,
    entitlements: { ...meWithChart.entitlements, full_report: true, full_report_chart_id: paidFor },
    ...extra,
  });

  const price = () => screen.findByRole('button', { name: new RegExp(`^${ru.chart.teaserCta} `) });
  const noPrice = () => {
    expect(screen.queryByRole('button', { name: new RegExp(`^${ru.chart.teaserCta} `) })).not.toBeInTheDocument();
  };
  const payButton = () => screen.findByRole('button', { name: new RegExp(`^${ru.paywall.pay} `) });

  /** Opens the app on a chart the user already has. */
  const openOn = (chartOnScreen: ChartResult, startMe: Me, prepare?: (fake: ReturnType<typeof fakeApi>) => void) =>
    setup({
      api: (fake) => {
        fake.getMe.mockResolvedValue(startMe);
        fake.getCurrentChart.mockResolvedValue(chartOnScreen);
        fake.getReport.mockResolvedValue(reportOfA);
        prepare?.(fake);
      },
    });

  it('two charts, `full_report: true` and `full_report_chart_id` = A on both: chart A offers «К разбору», chart B the price', async () => {
    // Chart A: the report was bought for it.
    const onA = openOn(chartA, meOn(CHART_A, CHART_A, { latest_report_id: REPORT_ID }));
    expect(await screen.findByRole('button', { name: 'К разбору' })).toBeInTheDocument();
    noPrice();
    onA.unmount();

    // Chart B of the same user. The server says the very same about the report: bought, for chart A.
    const onB = openOn(chartB, meOn(CHART_B, CHART_A, { latest_report_id: REPORT_ID }));
    expect(await price()).toHaveTextContent('149');
    expect(screen.queryByRole('button', { name: 'К разбору' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Получить разбор' })).not.toBeInTheDocument();
    expect(onB.api.orderReport).not.toHaveBeenCalled();
  });

  it('`full_report: true` with `full_report_chart_id: null`: the price. No chart is named, so no chart is paid for', async () => {
    const { api } = openOn(chartA, meOn(CHART_A, null));

    expect(await price()).toHaveTextContent('149');
    expect(screen.queryByRole('button', { name: 'Получить разбор' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'К разбору' })).not.toBeInTheDocument();
    expect(api.orderReport).not.toHaveBeenCalled();
  });

  it('the price on the chart that is not paid for leads to the paywall: no report is ordered, so the server has no 402 to answer with', async () => {
    const { api, user } = openOn(chartB, meOn(CHART_B, CHART_A));

    await user.click(await price());

    expect(heading()).toHaveTextContent(ru.paywall.title);
    expect(screen.getByRole('radio', { name: new RegExp(`^${ru.paywall.plans.one_149.title} `) })).toBeChecked();
    expect(api.orderReport).not.toHaveBeenCalled();

    // And what is paid for there is the report of the chart on screen, not of the one `Me` names.
    await user.click(await payButton());
    expect(api.createInvoice).toHaveBeenCalledWith({ plan_code: 'one_149', chart_id: CHART_B }, expect.any(AbortSignal));
  });

  it('bought for chart A, then another chart built from the form: the new chart shows the price, though the app still holds `full_report: true`', async () => {
    const { api, user } = openOn(chartA, meOn(CHART_A, CHART_A, { latest_report_id: REPORT_ID }), (fake) => {
      fake.createChart.mockResolvedValue({ ...chartB, is_restored: false });
    });
    expect(await screen.findByRole('button', { name: 'К разбору' })).toBeInTheDocument();

    // Other birth data, entered from the chart: the server builds chart B.
    await user.click(screen.getByRole('button', { name: ru.chart.enterAgain }));
    await user.click(consentBox());
    await user.click(proceed());
    await user.keyboard('17051994');
    await user.click(next());
    await enterTime(user, 'exact', '1430');
    await enterPlace(user);

    expect(await price()).toHaveTextContent('149');
    expect(screen.queryByRole('button', { name: 'К разбору' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Получить разбор' })).not.toBeInTheDocument();
    // `Me` was not asked again in between: the answer is in what the server said at the start.
    expect(api.getMe).toHaveBeenCalledTimes(1);
  });

  it('a chart whose report is paid for never shows the price, not even for the frame in which the chart arrives', async () => {
    const frames: string[] = [];
    const observer = new MutationObserver(() => {
      const text = document.body.textContent;
      if (text.includes(ru.chart.teaserLocked) || text.includes(ru.chart.teaserCta)) frames.push(text);
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    try {
      // No report is known yet, so the block has nothing to wait for: it is drawn with the chart.
      openOn(chartA, meOn(CHART_A, CHART_A));

      expect(await screen.findByRole('button', { name: 'Получить разбор' })).toBeInTheDocument();
      expect(frames).toEqual([]);
    } finally {
      observer.disconnect();
    }
  });

  describe('a payment for the report is confirmed for the chart it was made for', () => {
    it('`full_report: true` for another chart confirms nothing: no report is ordered until the server names this chart', async () => {
      // The user has a report of chart A and pays for chart B. Telegram says «paid»; the webhook is late.
      const reportOfB = { ...report, chart_id: CHART_B };
      const { api, analytics, user } = openOn(chartB, meOn(CHART_B, CHART_A), (fake) => {
        fake.orderReport.mockResolvedValue(reportOfB);
        fake.getReport.mockResolvedValue(reportOfB);
      });
      await user.click(await price());
      await user.click(await payButton());
      await act(() => vi.advanceTimersByTimeAsync(CONFIRM_INTERVAL_MS));

      expect(await screen.findByText(ru.paywall.processingTitle)).toBeInTheDocument();
      expect(api.orderReport).not.toHaveBeenCalled();
      expect(analytics.names()).not.toContain('payment_succeeded');

      // The payment has arrived: the server names chart B now.
      api.getMe.mockResolvedValue(meOn(CHART_B, CHART_B));
      await user.click(screen.getByRole('button', { name: ru.paywall.checkAgain }));

      expect(await screen.findByRole('heading', { level: 1, name: ru.report.queuedTitle })).toBeInTheDocument();
      expect(api.orderReport).toHaveBeenCalledTimes(1);
      expect(api.orderReport).toHaveBeenCalledWith({ chart_id: CHART_B, type: 'full' }, 'key-1', expect.any(AbortSignal));
      expect(analytics.events.filter((event) => event.name === 'payment_succeeded')).toEqual([
        { name: 'payment_succeeded', props: { plan_code: 'one_149' } },
      ]);
    });

    it('back on the chart meanwhile: «Платёж обрабатывается» and no price, and the late answer brings «Получить разбор» for this chart', async () => {
      const { api, user } = openOn(chartB, meOn(CHART_B, CHART_A));
      await user.click(await price());
      await user.click(await payButton());
      await act(() => vi.advanceTimersByTimeAsync(CONFIRM_INTERVAL_MS));
      await user.click(await screen.findByRole('button', { name: ru.paywall.leave }));

      expect(await screen.findByText(ru.chart.paymentPending)).toBeInTheDocument();
      noPrice();
      expect(screen.queryByRole('button', { name: 'Получить разбор' })).not.toBeInTheDocument();

      api.getMe.mockResolvedValue(meOn(CHART_B, CHART_B));
      await user.click(screen.getByRole('button', { name: ru.paywall.checkAgain }));

      expect(await screen.findByRole('button', { name: 'Получить разбор' })).toBeInTheDocument();
      expect(screen.queryByText(ru.chart.paymentPending)).not.toBeInTheDocument();
      noPrice();
      expect(api.createInvoice).toHaveBeenCalledTimes(1);
    });
  });
});
