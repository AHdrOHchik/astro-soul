import { act, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Me } from '../../api';
import { formatMoment } from '../../i18n/format';
import type { InvoiceOutcome } from '../../telegram';
import { ru } from '../../i18n/ru';
import {
  apiError,
  chart,
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
}

function setup({ me = meWithChart, afterPayment = me, telegram: host, api = fakeApi(), props }: SetupOptions = {}) {
  const telegram = fakeTelegram(host);
  const analytics = fakeAnalytics();
  const refreshMe = vi.fn<PaywallScreenProps['refreshMe']>().mockResolvedValue(afterPayment);
  const onReportPaid = vi.fn();
  const onClose = vi.fn();
  const onAwaiting = vi.fn<NonNullable<PaywallScreenProps['onAwaiting']>>();
  const user = setupUser();
  const view = render(
    <PaywallScreen
      api={api}
      telegram={telegram}
      me={me}
      refreshMe={refreshMe}
      reportChartId={chart.chart_id}
      initialPlan="one_149"
      track={analytics.track}
      onOpenTerms={vi.fn()}
      onReportPaid={onReportPaid}
      onClose={onClose}
      onAwaiting={onAwaiting}
      {...props}
    />,
  );
  return { api, telegram, analytics, refreshMe, onReportPaid, onClose, onAwaiting, user, ...view };
}

const payButton = () => screen.getByRole('button', { name: new RegExp(`^${copy.pay} `) });
const option = (title: string) => screen.getByRole('radio', { name: new RegExp(`^${title} `) });

afterEach(() => {
  vi.useRealTimers();
});

describe('PaywallScreen', () => {
  it('offers the report, already chosen, and the three subscriptions, with the prices of the shared plans', () => {
    const { analytics } = setup();

    expect(option(copy.plans.one_149.title)).toBeChecked();
    expect(screen.getAllByRole('radio')).toHaveLength(4);
    expect(option(copy.plans.month_399.title)).toHaveAccessibleName(`${copy.plans.month_399.title} 399 ${ru.common.stars.many}`);
    expect(payButton()).toHaveTextContent(`${copy.pay} 149`);
    // Opening the screen is counted by the app, with every other screen; the paywall itself counts what happens on it.
    expect(analytics.names()).toEqual([]);
  });

  it('paid by Telegram\'s word, not granted by the server: nothing is unlocked, the payment is «being processed»', async () => {
    // Telegram says «paid»; the server, asked twice, grants nothing yet.
    const { api, telegram, refreshMe, onReportPaid, onAwaiting, analytics, user } = setup({ telegram: { invoice: 'paid' } });

    await user.click(payButton());

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
    expect(onAwaiting).toHaveBeenCalledWith('one_149');
  });

  it('left while the invoice was open: the app still learns that Telegram called it paid, and asks the server', async () => {
    const closing = deferred<InvoiceOutcome>();
    const { telegram, refreshMe, onAwaiting, onReportPaid, user, unmount } = setup({ telegram: { invoice: closing.promise } });

    await user.click(payButton());
    await waitFor(() => {
      expect(telegram.openInvoice).toHaveBeenCalledTimes(1);
    });
    unmount();
    closing.resolve('paid');
    await act(() => vi.advanceTimersByTimeAsync(0));

    // Otherwise the chart would go on offering the price for what is already paid.
    expect(onAwaiting).toHaveBeenCalledWith('one_149');
    expect(refreshMe).toHaveBeenCalledTimes(1);
    expect(onReportPaid).not.toHaveBeenCalled();
  });

  it('opened while a payment is on its way: sells nothing, only asks the server again', async () => {
    const { refreshMe, user } = setup({ props: { awaiting: 'one_149' } });

    expect(screen.getByText(copy.processingTitle)).toBeInTheDocument();
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: new RegExp(`^${copy.pay} `) })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: copy.checkAgain }));

    expect(refreshMe).toHaveBeenCalledTimes(1);
    expect(await screen.findByText(copy.processingTitle)).toBeInTheDocument();
  });

  it('goes on to the report only when the server grants it', async () => {
    const { refreshMe, onReportPaid, user } = setup({ afterPayment: mePaid });

    await user.click(payButton());
    await screen.findByText(copy.confirmingTitle);
    await act(() => vi.advanceTimersByTimeAsync(0));

    expect(onReportPaid).toHaveBeenCalledTimes(1);
    expect(refreshMe).toHaveBeenCalledTimes(1);
  });

  it('a cancelled invoice is not a failure: no error text, the same paywall, nothing asked of the server', async () => {
    const { refreshMe, analytics, user } = setup({ telegram: { invoice: 'cancelled' } });

    await user.click(payButton());
    await act(() => vi.advanceTimersByTimeAsync(0));

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(payButton()).toBeEnabled();
    expect(option(copy.plans.one_149.title)).toBeChecked();
    expect(refreshMe).not.toHaveBeenCalled();
    expect(analytics.last()).toEqual({ name: 'payment_cancelled', props: { plan_code: 'one_149' } });
  });

  it('a failed payment says so and leaves the user to try again', async () => {
    const { analytics, user } = setup({ telegram: { invoice: 'failed' } });

    await user.click(payButton());

    expect(await screen.findByRole('alert')).toHaveTextContent(copy.failed);
    expect(payButton()).toBeEnabled();
    expect(analytics.last()).toEqual({ name: 'error_shown', props: { screen: 'paywall', code: 'payment_failed' } });
  });

  it('too many invoices (429): «try in an hour», with the time when the server names one, and no invoice is opened', async () => {
    const api = fakeApi();
    api.createInvoice.mockRejectedValueOnce(apiError('RATE_LIMITED', { status: 429, serverMessage: 'Слишком много запросов. Попробуй через минуту.' }));
    const { telegram, analytics, user } = setup({ api });

    await user.click(payButton());

    // The app's own text: the server's generic «через минуту» would be wrong for a limit of three an hour.
    expect((await screen.findByRole('alert')).textContent).toBe(copy.rateLimited);
    expect(copy.rateLimited).toContain('через час');
    expect(telegram.openInvoice).not.toHaveBeenCalled();
    expect(analytics.last()).toEqual({ name: 'error_shown', props: { screen: 'paywall', code: '429' } });

    const resetAt = '2026-11-10T13:30:00.000Z';
    api.createInvoice.mockRejectedValueOnce(apiError('RATE_LIMITED', { status: 429, details: { reset_at: resetAt } }));
    await user.click(payButton());
    expect(await screen.findByText(new RegExp(formatMoment(resetAt)))).toBeInTheDocument();
  });

  it('a refused invoice (422) is read in both forms the server sends it in, and shows the request id', async () => {
    const api = fakeApi();
    api.createInvoice
      .mockRejectedValueOnce(rejection({ field: 'chart_id', message: 'Выбери карту, для которой покупаешь разбор' }))
      .mockRejectedValueOnce(apiError('VALIDATION_FAILED', { status: 422, requestId: 'req-bare' }));
    const { user } = setup({ api });

    await user.click(payButton());
    const withFields = await screen.findByRole('alert');
    expect(withFields).toHaveTextContent(`${copy.invoiceRejected} Выбери карту, для которой покупаешь разбор`);
    expect(within(withFields).getByRole('button', { name: new RegExp('req-422') })).toBeInTheDocument();

    await user.click(payButton());
    expect(await screen.findByRole('button', { name: new RegExp('req-bare') })).toBeInTheDocument();
    expect(screen.getByRole('alert').textContent).toContain(copy.invoiceRejected);
  });

  it('shows the price the invoice names when it is not the expected one, and opens nothing until the user has seen it', async () => {
    const api = fakeApi();
    api.createInvoice.mockResolvedValue({ ...reportInvoice, stars: 199 });
    const { telegram, user } = setup({ api });

    await user.click(payButton());

    expect(await screen.findByRole('alert')).toHaveTextContent(`${copy.priceChanged} 199`);
    expect(telegram.openInvoice).not.toHaveBeenCalled();
    expect(payButton()).toHaveTextContent(`${copy.pay} 199`);
    expect(option(copy.plans.one_149.title)).toHaveAccessibleName(`${copy.plans.one_149.title} 199 ${ru.common.stars.many}`);

    // The second tap opens that very invoice: the server is not asked for another.
    await user.click(payButton());
    expect(telegram.openInvoice).toHaveBeenCalledTimes(1);
    expect(api.createInvoice).toHaveBeenCalledTimes(1);
  });

  it('outside Telegram: says that payment is in Telegram, warns in the console, asks the server for nothing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { api, telegram, user, unmount } = setup({ telegram: { isTelegram: false, canPay: false } });

    await user.click(payButton());

    expect(await screen.findByRole('alert')).toHaveTextContent(copy.unsupported);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(api.createInvoice).not.toHaveBeenCalled();
    expect(telegram.openInvoice).not.toHaveBeenCalled();
    unmount();

    // Inside a Telegram too old to open an invoice the words are other ones: the user is in Telegram already.
    const old = setup({ telegram: { isTelegram: true, canPay: false } });
    await old.user.click(payButton());
    expect(await screen.findByRole('alert')).toHaveTextContent(copy.outdated);
  });

  it('sells no subscription to a subscriber: says until when it is active, and leads on to the report', async () => {
    const onOpenReport = vi.fn();
    const { user } = setup({ me: meSubscribed, props: { reportChartId: null, initialPlan: null, onOpenReport } });

    expect(screen.getByRole('heading', { name: /^Подписка активна до \d+ декабря 2026 г\.$/ })).toBeInTheDocument();
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: ru.chart.openReport }));
    expect(onOpenReport).toHaveBeenCalledTimes(1);
  });
});
