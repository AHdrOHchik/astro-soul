import { StrictMode } from 'react';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApi, type Me, type PlanOffer } from '../../api';
import { ru } from '../../i18n/ru';
import { formatMoment } from '../../i18n/format';
import type { InvoiceOutcome } from '../../telegram';
import {
  apiError,
  chart,
  cataloguePlans,
  testCataloguePlans,
  deferred,
  fakeAnalytics,
  fakeApi,
  fakeTelegram,
  mePaid,
  meSubscribed,
  meWithChart,
  rejection,
  reportInvoice,
  setupUser,
} from '../../test/fixtures';
import { CONFIRM_INTERVAL_MS, PaywallScreen, type PaywallScreenProps } from './PaywallScreen';

const copy = ru.paywall;

interface SetupOptions {
  me?: Me;
  /** What the server says about the user when asked after a payment; the same as before by default: nothing arrived. */
  afterPayment?: Me;
  telegram?: Parameters<typeof fakeTelegram>[0];
  api?: ReturnType<typeof fakeApi>;
  props?: Partial<PaywallScreenProps>;
  strict?: boolean;
}

function setup({ me = meWithChart, afterPayment = me, telegram: host, api = fakeApi(), props, strict = false }: SetupOptions = {}) {
  const telegram = fakeTelegram(host);
  const analytics = fakeAnalytics();
  const refreshMe = vi.fn<PaywallScreenProps['refreshMe']>().mockResolvedValue(afterPayment);
  const onReportPaid = vi.fn();
  const onClose = vi.fn();
  const onAwaiting = vi.fn<NonNullable<PaywallScreenProps['onAwaiting']>>();
  const user = setupUser();
  const screenElement = (
    <PaywallScreen
      api={api}
      telegram={telegram}
      me={me}
      refreshMe={refreshMe}
      reportChartId={chart.chart_id}
      offersReport={props?.offersReport ?? (props?.reportChartId === undefined || props.reportChartId !== null)}
      initialKind="one_off"
      // A build that sells subscriptions (`VITE_SUBSCRIPTIONS=enabled`), unless a test says otherwise.
      subscriptions
      track={analytics.track}
      onOpenTerms={vi.fn()}
      onReportPaid={onReportPaid}
      onClose={onClose}
      onAwaiting={onAwaiting}
      {...props}
    />
  );
  const view = render(strict ? <StrictMode>{screenElement}</StrictMode> : screenElement);
  return { api, telegram, analytics, refreshMe, onReportPaid, onClose, onAwaiting, user, ...view };
}

const offer = (code: string, plans: PlanOffer[] = cataloguePlans): PlanOffer => {
  const found = plans.find((item) => item.plan_code === code);
  if (found === undefined) throw new Error(`Missing test catalogue offer: ${code}`);
  return found;
};
const payButton = () => screen.findByRole('button', { name: new RegExp(`^${copy.pay} `) });
const option = (title: string) => screen.findByRole('radio', { name: new RegExp(`^${title} `) });

afterEach(() => {
  vi.useRealTimers();
});

describe('PaywallScreen', () => {
  it('renders the server response envelope as a tariff with its 149-star price', async () => {
    const body = {
      plans: [
        {
          plan_code: 'one_149',
          kind: 'one_off',
          stars: 149,
          period_sec: null,
          title: 'Полный разбор',
          subtitle: 'Все главы разбора по этой карте. Разовая покупка, без подписки.',
          includes: ['Все главы разбора по этой карте', 'PDF-файл'],
          test: false,
        },
      ],
    };
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );
    const liveApi = createApi({ baseUrl: 'https://api.test', getInitData: () => 'signed-init-data', fetch: fetchMock });
    const api = fakeApi();
    api.getPlans.mockImplementation((signal) => liveApi.getPlans(signal));
    setup({ api, props: { subscriptions: false } });

    expect(await screen.findByRole('radio', { name: /Полный разбор 149 звёзд/ })).toBeChecked();
    expect(await payButton()).toHaveTextContent('Оплатить 149');
    expect(screen.getByText('Все главы разбора по этой карте. Разовая покупка, без подписки.')).toBeInTheDocument();
  });

  it('offers only the server compatibility tariff and shows its required single-pair disclosure', async () => {
    const compatibilityOffer = offer('compat_249');
    const { api } = setup({
      api: fakeApi(),
      props: { compatibilityPurchase: true, offersReport: false, reportChartId: null, subscriptions: false },
    });

    expect(await screen.findAllByRole('radio')).toHaveLength(1);
    expect(await option(compatibilityOffer.title)).toBeChecked();
    expect(await payButton()).toHaveTextContent(`${copy.pay} ${String(compatibilityOffer.stars)}`);
    expect(screen.getByText(ru.compatibility.purchaseDisclosure)).toBeInTheDocument();
    expect(api.getPlans).toHaveBeenCalledOnce();
  });

  it('does not turn the StrictMode cleanup AbortError into a catalogue error', async () => {
    const pending = deferred<PlanOffer[]>();
    const api = fakeApi();
    api.getPlans
      .mockImplementationOnce((signal) => new Promise<PlanOffer[]>((_resolve, reject) => {
        signal?.addEventListener('abort', () => {
          reject(new DOMException('Aborted', 'AbortError'));
        }, { once: true });
      }))
      .mockReturnValueOnce(pending.promise);
    setup({ api, strict: true });

    await waitFor(() => {
      expect(api.getPlans).toHaveBeenCalledTimes(2);
    });
    expect(screen.getByRole('status')).toHaveTextContent(copy.loadingPlans);
    expect(screen.queryByRole('heading', { name: copy.plansError })).not.toBeInTheDocument();
    pending.resolve(cataloguePlans);
    expect(await option(offer('one_149').title)).toBeInTheDocument();
  });

  it('offers the report and subscriptions with server-supplied details and prices', async () => {
    const { analytics, api } = setup();

    expect(await option(offer('one_149').title)).toBeChecked();
    expect(api.getPlans).toHaveBeenCalledTimes(1);
    expect(await screen.findAllByRole('radio')).toHaveLength(6);
    expect(await option(offer('month_399').title)).toHaveAccessibleName(`${offer('month_399').title} 399 ${ru.common.stars.many}`);
    expect(await payButton()).toHaveTextContent(`${copy.pay} 149`);
    // Opening the screen is counted by the app, with every other screen; the paywall itself counts what happens on it.
    expect(analytics.names()).toEqual([]);
    expect(screen.queryByRole('heading', { name: copy.testPlans })).not.toBeInTheDocument();
    expect(screen.getByText(offer('one_149').subtitle)).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(cataloguePlans.reduce((sum, item) => sum + item.includes.length, 0));
  });

  it('shows every server test offer in a separate block and invoices the selected server code', async () => {
    const api = fakeApi();
    const testReport = offer('test_report_1', testCataloguePlans);
    api.getPlans.mockResolvedValue(testCataloguePlans);
    api.createInvoice.mockResolvedValue({ ...reportInvoice, plan_code: testReport.plan_code, stars: testReport.stars });
    const { user, telegram } = setup({ api });

    const testRegion = await screen.findByRole('region', { name: copy.testPlans });
    const testSubscription = await option(offer('test_1', testCataloguePlans).title);
    const testReportRadio = await option(testReport.title);
    expect(testRegion.contains(testSubscription)).toBe(true);
    expect(testRegion.contains(testReportRadio)).toBe(true);
    expect(screen.getByRole('heading', { name: copy.testPlans })).toBeInTheDocument();

    await user.click(testReportRadio);
    expect(await payButton()).toHaveTextContent(`${copy.pay} 1`);
    expect(screen.getByText(copy.testPlansNote)).toBeInTheDocument();
    await user.click(await payButton());

    expect(api.createInvoice).toHaveBeenCalledWith({ plan_code: testReport.plan_code, chart_id: chart.chart_id }, expect.any(AbortSignal));
    expect(telegram.openInvoice).toHaveBeenCalledWith(reportInvoice.invoice_link);
  });

  it('loads no offers as an empty state and never treats a missing list as a successful empty response', async () => {
    const api = fakeApi();
    api.getPlans.mockResolvedValue([]);
    setup({ api });
    expect(await screen.findByRole('heading', { name: copy.nothingOnSale })).toBeInTheDocument();
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
  });

  it('shows a retryable error after a server failure', async () => {
    const api = fakeApi();
    api.getPlans
      .mockRejectedValueOnce(apiError('INTERNAL', { status: 500 }))
      .mockResolvedValueOnce(cataloguePlans);
    const { user } = setup({ api });

    expect(await screen.findByRole('heading', { name: copy.plansError })).toBeInTheDocument();
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: copy.retryPlans }));
    expect(await option(offer('one_149').title)).toBeInTheDocument();
  });

  it('shows a retryable error after a network failure', async () => {
    const api = fakeApi();
    api.getPlans.mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValueOnce(cataloguePlans);
    const { user } = setup({ api });

    expect(await screen.findByRole('heading', { name: copy.plansError })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: copy.retryPlans }));
    expect(await option(offer('one_149').title)).toBeInTheDocument();
    expect(api.getPlans).toHaveBeenCalledTimes(2);
  });

  it('explains an expired initData session instead of offering a futile retry', async () => {
    const api = fakeApi();
    api.getPlans.mockRejectedValue(apiError('UNAUTHORIZED', { status: 401 }));
    setup({ api });

    expect(await screen.findByRole('heading', { name: copy.sessionExpired })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: copy.retryPlans })).not.toBeInTheDocument();
  });

  it('keeps the loading skeleton in the card area until the catalogue arrives', async () => {
    const pending = deferred<PlanOffer[]>();
    const api = fakeApi();
    api.getPlans.mockReturnValue(pending.promise);
    setup({ api });

    expect(screen.getByRole('status')).toHaveTextContent(copy.loadingPlans);
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
    pending.resolve(cataloguePlans);
    expect(await option(offer('one_149').title)).toBeInTheDocument();
  });

  it('renders only server-provided includes and omits the list for an empty includes array', async () => {
    const api = fakeApi();
    const plans = cataloguePlans.map((item) => item.plan_code === 'compat_249' ? { ...item, includes: [] } : item);
    api.getPlans.mockResolvedValue(plans);
    setup({ api });

    const reportRadio = await option(offer('one_149').title);
    const reportOffer = reportRadio.closest('div');
    expect(reportOffer?.querySelectorAll('li')).toHaveLength(2);
    const emptyOfferRadio = await option(offer('compat_249').title);
    expect(emptyOfferRadio.closest('div')?.querySelector('ul')).toBeNull();
  });

  it('confirms a compatibility purchase only from the server quota, without asking the unrelated Me endpoint', async () => {
    const compatibilityOffer = offer('compat_249');
    const api = fakeApi();
    api.createInvoice.mockResolvedValue({ ...reportInvoice, plan_code: compatibilityOffer.plan_code, stars: compatibilityOffer.stars });
    const refreshCompatibility = vi.fn<NonNullable<PaywallScreenProps['refreshCompatibility']>>().mockResolvedValue({ items: [], quota: { kind: 'purchase', left: 1, resets_at: null } });
    const onCompatibilityPaid = vi.fn();
    const { telegram, refreshMe, analytics, user } = setup({
      api,
      telegram: { invoice: 'paid' },
      props: {
        compatibilityPurchase: true,
        offersReport: false,
        reportChartId: null,
        subscriptions: false,
        refreshCompatibility,
        onCompatibilityPaid,
      },
    });

    await user.click(await payButton());
    expect(await screen.findByText(copy.confirmingTitle)).toBeInTheDocument();
    await waitFor(() => { expect(onCompatibilityPaid).toHaveBeenCalledOnce(); });
    expect(refreshCompatibility).toHaveBeenCalledOnce();
    expect(refreshMe).not.toHaveBeenCalled();
    expect(telegram.openInvoice).toHaveBeenCalledWith(reportInvoice.invoice_link);
    expect(analytics.events).toContainEqual({ name: 'payment_succeeded', props: { plan_code: 'compat_249' } });
  });

  it('paid by Telegram\'s word, not granted by the server: nothing is unlocked, the payment is «being processed»', async () => {
    // Telegram says «paid»; the server, asked twice, grants nothing yet.
    const { api, telegram, refreshMe, onReportPaid, onAwaiting, analytics, user } = setup({ telegram: { invoice: 'paid' } });

    await user.click(await payButton());

    expect(api.createInvoice).toHaveBeenCalledWith({ plan_code: 'one_149', chart_id: chart.chart_id }, expect.any(AbortSignal));
    expect(telegram.openInvoice).toHaveBeenCalledWith(reportInvoice.invoice_link);
    expect(await screen.findByText(copy.confirmingTitle)).toBeInTheDocument();
    expect(refreshMe).toHaveBeenCalledTimes(1);

    await act(() => vi.advanceTimersByTimeAsync(CONFIRM_INTERVAL_MS));

    expect(await screen.findByText(copy.processingTitle)).toBeInTheDocument();
    expect(screen.getByText(copy.processingText)).toBeInTheDocument();
    expect(refreshMe).toHaveBeenCalledTimes(2);
    expect(onReportPaid).not.toHaveBeenCalled();
    expect(analytics.names()).toEqual(['checkout_started', 'checkout_opened']);
    // The app is told which payment is on its way: nothing may offer to pay for the report again meanwhile.
    expect(onAwaiting).toHaveBeenCalledWith(offer('one_149'), true);
  });

  it('left while the invoice was open: the app still learns that Telegram called it paid, and asks the server', async () => {
    const closing = deferred<InvoiceOutcome>();
    const { telegram, refreshMe, onAwaiting, onReportPaid, user, unmount } = setup({ telegram: { invoice: closing.promise } });

    await user.click(await payButton());
    await waitFor(() => {
      expect(telegram.openInvoice).toHaveBeenCalledTimes(1);
    });
    unmount();
    closing.resolve('paid');
    await act(() => vi.advanceTimersByTimeAsync(0));

    // Otherwise the chart would go on offering the price for what is already paid.
    expect(onAwaiting).toHaveBeenCalledWith(offer('one_149'), true);
    expect(refreshMe).toHaveBeenCalledTimes(1);
    expect(onReportPaid).not.toHaveBeenCalled();
  });

  it('opened while a payment is on its way: sells nothing, only asks the server again', async () => {
    const { refreshMe, user } = setup({ props: { awaiting: { planCode: 'one_149', kind: 'one_off', report: true } } });

    expect(screen.getByText(copy.processingTitle)).toBeInTheDocument();
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: new RegExp(`^${copy.pay} `) })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: copy.checkAgain }));

    expect(refreshMe).toHaveBeenCalledTimes(1);
    expect(await screen.findByText(copy.processingTitle)).toBeInTheDocument();
  });

  it('goes on to the report only when the server grants it', async () => {
    const { refreshMe, onReportPaid, user } = setup({ afterPayment: mePaid });

    await user.click(await payButton());
    await screen.findByText(copy.confirmingTitle);
    await act(() => vi.advanceTimersByTimeAsync(0));

    expect(onReportPaid).toHaveBeenCalledTimes(1);
    expect(refreshMe).toHaveBeenCalledTimes(1);
  });

  it('a cancelled invoice is not a failure: no error text, the same paywall, nothing asked of the server', async () => {
    const { refreshMe, analytics, user } = setup({ telegram: { invoice: 'cancelled' } });

    await user.click(await payButton());
    await act(() => vi.advanceTimersByTimeAsync(0));

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(await payButton()).toBeEnabled();
    expect(await option(offer('one_149').title)).toBeChecked();
    expect(refreshMe).not.toHaveBeenCalled();
    expect(analytics.last()).toEqual({ name: 'payment_cancelled', props: { plan_code: 'one_149' } });
  });

  it('a failed payment says so and leaves the user to try again', async () => {
    const { analytics, user } = setup({ telegram: { invoice: 'failed' } });

    await user.click(await payButton());

    expect(await screen.findByRole('alert')).toHaveTextContent(copy.failed);
    expect(await payButton()).toBeEnabled();
    expect(analytics.last()).toEqual({ name: 'error_shown', props: { screen: 'paywall', code: 'payment_failed' } });
  });

  it('too many invoices (429): «try in an hour», with the time when the server names one, and no invoice is opened', async () => {
    const api = fakeApi();
    api.createInvoice.mockRejectedValueOnce(apiError('RATE_LIMITED', { status: 429, serverMessage: 'Слишком много запросов. Попробуй через минуту.' }));
    const { telegram, analytics, user } = setup({ api });

    await user.click(await payButton());

    // The app's own text: the server's generic «через минуту» would be wrong for a limit of three an hour.
    expect((await screen.findByRole('alert')).textContent).toBe(copy.rateLimited);
    expect(copy.rateLimited).toContain('через час');
    expect(telegram.openInvoice).not.toHaveBeenCalled();
    expect(analytics.last()).toEqual({ name: 'error_shown', props: { screen: 'paywall', code: '429' } });

    const resetAt = '2026-11-10T13:30:00.000Z';
    api.createInvoice.mockRejectedValueOnce(apiError('RATE_LIMITED', { status: 429, details: { reset_at: resetAt } }));
    await user.click(await payButton());
    expect(await screen.findByText(new RegExp(formatMoment(resetAt)))).toBeInTheDocument();
  });

  it('a refused invoice (422) is read in both forms the server sends it in, and shows the request id', async () => {
    const api = fakeApi();
    api.createInvoice
      .mockRejectedValueOnce(rejection({ field: 'chart_id', message: 'Выбери карту, для которой покупаешь разбор' }))
      .mockRejectedValueOnce(apiError('VALIDATION_FAILED', { status: 422, requestId: 'req-bare' }));
    const { user } = setup({ api });

    await user.click(await payButton());
    const withFields = await screen.findByRole('alert');
    expect(withFields).toHaveTextContent(`${copy.invoiceRejected} Выбери карту, для которой покупаешь разбор`);
    expect(within(withFields).getByRole('button', { name: new RegExp('req-422') })).toBeInTheDocument();

    await user.click(await payButton());
    expect(await screen.findByRole('button', { name: new RegExp('req-bare') })).toBeInTheDocument();
    expect(screen.getByRole('alert').textContent).toContain(copy.invoiceRejected);
  });

  it('shows the price the invoice names when it is not the expected one, and opens nothing until the user has seen it', async () => {
    const api = fakeApi();
    api.createInvoice.mockResolvedValue({ ...reportInvoice, stars: 199 });
    const { telegram, user } = setup({ api });

    await user.click(await payButton());

    expect(await screen.findByRole('alert')).toHaveTextContent(`${copy.priceChanged} 199`);
    expect(telegram.openInvoice).not.toHaveBeenCalled();
    expect(await payButton()).toHaveTextContent(`${copy.pay} 199`);
    expect(await option(offer('one_149').title)).toHaveAccessibleName(`${offer('one_149').title} 199 ${ru.common.stars.many}`);

    // The second tap opens that very invoice: the server is not asked for another.
    await user.click(await payButton());
    expect(telegram.openInvoice).toHaveBeenCalledTimes(1);
    expect(api.createInvoice).toHaveBeenCalledTimes(1);
  });

  it('outside Telegram: says that payment is in Telegram, warns in the console, asks the server for nothing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { api, telegram, user, unmount } = setup({ telegram: { isTelegram: false, canPay: false } });

    await user.click(await payButton());

    expect(await screen.findByRole('alert')).toHaveTextContent(copy.unsupported);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(api.createInvoice).not.toHaveBeenCalled();
    expect(telegram.openInvoice).not.toHaveBeenCalled();
    unmount();

    // Inside a Telegram too old to open an invoice the words are other ones: the user is in Telegram already.
    const old = setup({ telegram: { isTelegram: true, canPay: false } });
    await old.user.click(await payButton());
    expect(await screen.findByRole('alert')).toHaveTextContent(copy.outdated);
  });

  it('sells no subscription to a subscriber: says until when it is active, and leads on to the report', async () => {
    const onOpenReport = vi.fn();
    const { user } = setup({ me: meSubscribed, props: { reportChartId: null, initialKind: null, onOpenReport } });

    expect(await screen.findByRole('heading', { name: /^Подписка активна до \d+ декабря 2026 г\.$/ })).toBeInTheDocument();
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: ru.chart.openReport }));
    expect(onOpenReport).toHaveBeenCalledTimes(1);
  });
});


  it('a just-confirmed subscription with no chart says the subscription remains and offers to build a chart', async () => {
    const afterPayment: Me = { ...meSubscribed, has_chart: false, chart_id: null };
    const api = fakeApi();
    api.createInvoice.mockResolvedValue({
      ...reportInvoice,
      plan_code: 'month_399',
      stars: 399,
      is_subscription: true,
      subscription_period_sec: 30 * 24 * 60 * 60,
    });
    const onBuildChart = vi.fn();
    const { user } = setup({
      me: { ...meWithChart, has_chart: false, chart_id: null },
      afterPayment,
      telegram: { invoice: 'paid' },
      api,
      props: { reportChartId: null, initialKind: 'subscription', onBuildChart },
    });

    await user.click(await option(offer('month_399').title));
    await user.click(await payButton());

    expect(await screen.findByText(copy.subscriptionWithoutChart)).toBeInTheDocument();
    const build = screen.getByRole('button', { name: copy.buildChart });
    expect(build).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: copy.leave })).not.toBeInTheDocument();
    await user.click(build);
    expect(onBuildChart).toHaveBeenCalledTimes(1);
  });

  it('does not add the missing-chart message for an active subscription when its chart exists', async () => {
    setup({ me: meSubscribed });
    expect(screen.queryByText(copy.subscriptionWithoutChart)).not.toBeInTheDocument();
    expect(await screen.findByRole('radio', { name: new RegExp(`^${offer('one_149').title}`) })).toBeInTheDocument();
  });

describe('PaywallScreen: a build that sells no subscriptions (`subscriptions: false`)', () => {
  const subscriptionPlans = ['week_149', 'month_399', 'year_2990'] as const;

  it('sells the report alone: the subscriptions are not in the document at all, hidden or otherwise', async () => {
    const { api, user, container } = setup({ props: { subscriptions: false } });

    expect(await screen.findAllByRole('radio')).toHaveLength(3);
    expect(await option(offer('one_149').title)).toBeChecked();
    for (const code of subscriptionPlans) {
      expect(screen.queryByText(offer(code).title)).not.toBeInTheDocument();
      expect(screen.queryByText(offer(code).subtitle)).not.toBeInTheDocument();
    }
    // No offer of a subscription and no price of one anywhere in the markup: nothing to reveal with a style.
    // The one mention left is the report's own «без подписки», which is about the report.
    expect(offer('one_149').subtitle).toMatch(/без подписки/);
    expect(container.innerHTML.replace(offer('one_149').subtitle, '')).not.toMatch(/подписк/i);
    expect(container.innerHTML).not.toMatch(/399|2.990/);
    expect(container.querySelectorAll('input')).toHaveLength(3);
    expect(screen.queryByText(copy.reportIsSeparate)).not.toBeInTheDocument();
    expect(screen.queryByText(copy.renewal)).not.toBeInTheDocument();

    await user.click(await payButton());
    await waitFor(() => {
      expect(api.createInvoice).toHaveBeenCalledTimes(1);
    });
    expect(api.createInvoice).toHaveBeenCalledWith({ plan_code: 'one_149', chart_id: chart.chart_id }, expect.any(AbortSignal));
  });

  it.each(subscriptionPlans)('has nothing chosen and nothing to pay when the screen is opened for %s: no invoice can be asked for', async () => {
    const { api, user } = setup({ props: { subscriptions: false, initialKind: 'subscription' } });

    expect(await screen.findAllByRole('radio')).toHaveLength(3);
    expect(await option(offer('one_149').title)).not.toBeChecked();
    const pay = screen.getByRole('button', { name: copy.choose });
    expect(pay).toBeDisabled();
    await user.click(pay);
    expect(api.createInvoice).not.toHaveBeenCalled();
  });

  it('says that there is nothing to pay for when there is no report to buy either, and leads back', async () => {
    const { api, onClose, user, container } = setup({ props: { subscriptions: false, reportChartId: null, initialKind: null } });

    expect(await screen.findByRole('heading', { name: 'Сейчас здесь нечего оплачивать' })).toBeInTheDocument();
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
    expect(container.innerHTML).not.toMatch(/подписк/i);
    expect(screen.getAllByRole('button').map((button) => button.textContent)).toEqual([copy.leave]);
    await user.click(screen.getByRole('button', { name: copy.leave }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(api.createInvoice).not.toHaveBeenCalled();
  });

  it('still shows the subscription the user has: what was bought does not disappear with the offer', async () => {
    setup({ me: meSubscribed, props: { subscriptions: false } });
    expect(await screen.findByText(/^Подписка активна до \d+ декабря 2026 г\.$/)).toBeInTheDocument();
    expect(await screen.findAllByRole('radio')).toHaveLength(3);
  });

  it('sells none unless told to: the prop left out is the same as `false`', async () => {
    setup({ props: { subscriptions: undefined } });
    expect(await screen.findAllByRole('radio')).toHaveLength(3);
    for (const code of subscriptionPlans) expect(screen.queryByText(offer(code).title)).not.toBeInTheDocument();
  });

  it('sells them when told to', async () => {
    setup({ props: { subscriptions: true } });
    expect(await screen.findAllByRole('radio')).toHaveLength(6);
    for (const code of subscriptionPlans) expect(await option(offer(code).title)).toBeInTheDocument();
  });

  it('filters subscription offers from both regular and test blocks when subscriptions are disabled', async () => {
    const api = fakeApi();
    api.getPlans.mockResolvedValue(testCataloguePlans);
    setup({ api, props: { subscriptions: false } });

    await option(offer('one_149').title);
    for (const code of subscriptionPlans) expect(screen.queryByText(offer(code).title)).not.toBeInTheDocument();
    expect(screen.queryByText(offer('test_1', testCataloguePlans).title)).not.toBeInTheDocument();
    expect(await screen.findByText(offer('test_report_1', testCataloguePlans).title)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: copy.testPlans })).toBeInTheDocument();
  });
});

describe('PaywallScreen: the chart the report is for is gone', () => {
  /** The answer of apps/api to an invoice for a chart that is not the user's (`billing.service.ts`). */
  const chartRejected = () => rejection({ field: 'chart_id', message: 'Карта не найдена' });

  it('leaves the screen to the app: no failure is shown, and not a word of the server\'s', async () => {
    const api = fakeApi();
    api.createInvoice.mockRejectedValue(chartRejected());
    const onChartGone = vi.fn();
    const { analytics, telegram, user } = setup({ api, props: { onChartGone } });
    analytics.clear();

    await user.click(await payButton());
    await waitFor(() => {
      expect(onChartGone).toHaveBeenCalledTimes(1);
    });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByText('Карта не найдена')).not.toBeInTheDocument();
    expect(telegram.openInvoice).not.toHaveBeenCalled();
    expect(analytics.names()).not.toContain('error_shown');
  });

  it('is told from any other refusal by the field the server names', async () => {
    const api = fakeApi();
    api.createInvoice.mockRejectedValue(rejection({ field: 'plan_code', message: 'plan_code — один из тарифов каталога' }));
    const onChartGone = vi.fn();
    const { user } = setup({ api, props: { onChartGone } });

    await user.click(await payButton());
    expect(await screen.findByRole('alert')).toHaveTextContent(copy.invoiceRejected);
    expect(onChartGone).not.toHaveBeenCalled();
  });

  it('is not read into the refusal of a subscription: that invoice names no chart', async () => {
    const api = fakeApi();
    api.createInvoice.mockRejectedValue(chartRejected());
    const onChartGone = vi.fn();
    const { user } = setup({ api, props: { onChartGone, initialKind: 'subscription' } });

    await user.click(await option(offer('month_399').title));
    await user.click(await payButton());
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(api.createInvoice).toHaveBeenCalledWith({ plan_code: 'month_399' }, expect.any(AbortSignal));
    expect(onChartGone).not.toHaveBeenCalled();
  });

  it('is shown like any refusal where nobody takes it from the screen', async () => {
    const api = fakeApi();
    api.createInvoice.mockRejectedValue(chartRejected());
    const { user } = setup({ api });

    await user.click(await payButton());
    expect(await screen.findByRole('alert')).toHaveTextContent(copy.invoiceRejected);
  });
});

describe('PaywallScreen: the report is confirmed for the chart it was paid for (`full_report_chart_id`)', () => {
  const OTHER_CHART = '00000000-0000-4000-8000-0000000000b0';
  /** The server's word that a report is bought, and for which chart; null names none. */
  const boughtFor = (chartId: string | null): Me => ({
    ...meWithChart,
    entitlements: { ...meWithChart.entitlements, full_report: true, full_report_chart_id: chartId },
  });

  it('`full_report: true` for another chart is not this purchase: nothing is unlocked, the payment is «being processed»', async () => {
    // The user had a report of another chart before paying for this one, and the webhook is late.
    const { refreshMe, onReportPaid, user } = setup({ me: boughtFor(OTHER_CHART), afterPayment: boughtFor(OTHER_CHART) });

    await user.click(await payButton());
    await screen.findByText(copy.confirmingTitle);
    await act(() => vi.advanceTimersByTimeAsync(CONFIRM_INTERVAL_MS));

    expect(await screen.findByText(copy.processingTitle)).toBeInTheDocument();
    expect(refreshMe).toHaveBeenCalledTimes(2);
    expect(onReportPaid).not.toHaveBeenCalled();
  });

  it('nor is `full_report: true` with no chart named', async () => {
    const { onReportPaid, user } = setup({ afterPayment: boughtFor(null) });

    await user.click(await payButton());
    await screen.findByText(copy.confirmingTitle);
    await act(() => vi.advanceTimersByTimeAsync(CONFIRM_INTERVAL_MS));

    expect(await screen.findByText(copy.processingTitle)).toBeInTheDocument();
    expect(onReportPaid).not.toHaveBeenCalled();
  });

  it('the server naming this chart is: on to the report', async () => {
    const { onReportPaid, user } = setup({ me: boughtFor(OTHER_CHART), afterPayment: boughtFor(chart.chart_id) });

    await user.click(await payButton());
    await screen.findByText(copy.confirmingTitle);
    await act(() => vi.advanceTimersByTimeAsync(0));

    expect(onReportPaid).toHaveBeenCalledTimes(1);
  });

  it('opened while a payment for another chart is on its way: «Проверить ещё раз» asks about that chart, not about the one on this screen', async () => {
    // Paid for OTHER_CHART a moment ago; this paywall was opened from the chart of the fixtures.
    const { refreshMe, onReportPaid, user } = setup({
      afterPayment: boughtFor(OTHER_CHART),
      props: { awaiting: { planCode: 'one_149', kind: 'one_off', report: true }, awaitingChartId: OTHER_CHART },
    });
    expect(screen.getByText(copy.processingTitle)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: copy.checkAgain }));

    await waitFor(() => {
      expect(onReportPaid).toHaveBeenCalledTimes(1);
    });
    expect(refreshMe).toHaveBeenCalledTimes(1);
  });

  it('and the report this screen could sell is not taken for that payment', async () => {
    // The server names the chart of this screen, and the payment on its way was for another one.
    const { onReportPaid, user } = setup({
      afterPayment: boughtFor(chart.chart_id),
      props: { awaiting: { planCode: 'one_149', kind: 'one_off', report: true }, awaitingChartId: OTHER_CHART },
    });

    await user.click(screen.getByRole('button', { name: copy.checkAgain }));

    expect(await screen.findByText(copy.processingTitle)).toBeInTheDocument();
    expect(onReportPaid).not.toHaveBeenCalled();
  });

  it('a subscription is confirmed by `is_active`, with no chart in the question', async () => {
    const api = fakeApi();
    api.createInvoice.mockResolvedValue({ ...reportInvoice, plan_code: 'month_399', stars: 399, is_subscription: true, subscription_period_sec: 2592000 });
    const { refreshMe, onReportPaid, user } = setup({ api, afterPayment: meSubscribed, props: { subscriptions: true, initialKind: 'subscription' } });

    await user.click(await option(offer('month_399').title));
    await user.click(await payButton());
    await act(() => vi.advanceTimersByTimeAsync(0));

    // Granted at the first question: the screen is the paywall again, with nothing «being processed». The report was not bought.
    await waitFor(() => {
      expect(refreshMe).toHaveBeenCalledTimes(1);
    });
    expect(await screen.findByRole('heading', { level: 1, name: copy.title })).toBeInTheDocument();
    expect(screen.queryByText(copy.processingTitle)).not.toBeInTheDocument();
    expect(onReportPaid).not.toHaveBeenCalled();
  });
});
