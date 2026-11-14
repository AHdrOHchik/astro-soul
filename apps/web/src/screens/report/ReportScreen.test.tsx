import { act, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Report } from '../../api';
import { ru } from '../../i18n/ru';
import {
  apiError,
  chart,
  fakeAnalytics,
  fakeApi,
  fakeKeys,
  fakeTelegram,
  rejection,
  report,
  REPORT_ID,
  sections,
  setupUser,
} from '../../test/fixtures';
import { ReportScreen, type ReportScreenProps } from './ReportScreen';
import { POLL_DELAYS_MS, STALL_MS } from './useReport';

const copy = ru.report;

const generating: Report = { ...report, status: 'generating', progress: 40, sections };
const ready: Report = { ...report, status: 'ready', progress: 100, sections };

interface SetupOptions {
  api?: ReturnType<typeof fakeApi>;
  /** What every answer about the report is; queued by default. */
  answer?: Report;
  props?: Partial<ReportScreenProps>;
}

function setup({ api = fakeApi(), answer, props }: SetupOptions = {}) {
  if (answer) api.getReport.mockResolvedValue(answer);
  const telegram = fakeTelegram();
  const analytics = fakeAnalytics();
  const onPaymentRequired = vi.fn<ReportScreenProps['onPaymentRequired']>();
  const user = setupUser();
  const view = render(
    <ReportScreen
      api={api}
      telegram={telegram}
      keys={fakeKeys()}
      chartId={chart.chart_id}
      reportId={REPORT_ID}
      orderAtOnce={false}
      justPaid={false}
      apiBaseUrl="https://api.test"
      supportLink=""
      share={null}
      track={analytics.track}
      onPaymentRequired={onPaymentRequired}
      {...props}
    />,
  );
  return { api, telegram, analytics, onPaymentRequired, user, ...view };
}

/** Lets the timers run for `ms`, and the answers that follow them arrive. */
const pass = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

function setHidden(hidden: boolean) {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
  document.dispatchEvent(new Event('visibilitychange'));
}

afterEach(() => {
  vi.useRealTimers();
  Reflect.deleteProperty(document, 'hidden');
});

describe('ReportScreen: a report in work', () => {
  it('shows the server\'s progress and the chapters that have come, and invents none of the rest', async () => {
    setup({ answer: generating });

    expect(await screen.findByRole('heading', { level: 1, name: copy.generatingTitle })).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: copy.progressLabel })).toHaveAttribute('value', '40');
    expect(screen.getByText('Готово 2 из 7 глав')).toBeInTheDocument();
    for (const section of sections) {
      const chapter = within(screen.getByRole('region', { name: section.title }));
      expect(chapter.getByText(section.body_md)).toBeInTheDocument();
    }
    // Two chapters came: two are on screen. No placeholder stands for the other five.
    expect(screen.getAllByRole('heading', { level: 2 })).toHaveLength(2);
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
  });

  it('never shows 100 before the server calls the report ready', async () => {
    setup({ answer: { ...generating, progress: 100 } });

    expect(await screen.findByRole('progressbar')).toHaveAttribute('value', '99');
  });

  it('asks at once, then after 2 s, and twice as rarely while nothing changes, up to 10 s', async () => {
    const { api } = setup();

    await pass(0);
    expect(api.getReport).toHaveBeenCalledTimes(1);
    expect(api.getReport).toHaveBeenCalledWith(REPORT_ID, expect.any(AbortSignal));
    expect(POLL_DELAYS_MS).toEqual([2000, 4000, 8000, 10_000]);

    let calls = 1;
    for (const delay of [2000, 4000, 8000, 10_000, 10_000]) {
      await pass(delay - 1);
      expect(api.getReport).toHaveBeenCalledTimes(calls);
      await pass(1);
      calls += 1;
      expect(api.getReport).toHaveBeenCalledTimes(calls);
    }

    // Something new: back to the short pause.
    api.getReport.mockResolvedValue(generating);
    await pass(10_000);
    await pass(2000);
    expect(api.getReport).toHaveBeenCalledTimes(calls + 2);
  });

  it('asks nothing while the page is hidden, and at once when it is back', async () => {
    const { api } = setup();
    await pass(0);
    expect(api.getReport).toHaveBeenCalledTimes(1);

    setHidden(true);
    await pass(60_000);
    expect(api.getReport).toHaveBeenCalledTimes(1);

    setHidden(false);
    await pass(0);
    expect(api.getReport).toHaveBeenCalledTimes(2);
  });

  it('stops asking when the screen is left', async () => {
    const { api, unmount } = setup({ answer: generating });
    await screen.findByRole('progressbar');
    const asked = api.getReport.mock.calls.length;

    unmount();
    await pass(120_000);

    expect(api.getReport).toHaveBeenCalledTimes(asked);
    // Whatever was on its way is cancelled too.
    expect(api.getReport.mock.calls.every(([, signal]) => signal?.aborted)).toBe(true);
  });

  it('says so when nothing has changed for a minute, offers support, and does not offer to pay again', async () => {
    setup({ answer: generating });
    await screen.findByRole('progressbar');
    expect(screen.queryByText(copy.stalled)).not.toBeInTheDocument();

    await pass(STALL_MS);

    expect(screen.getByText(copy.stalled)).toBeInTheDocument();
    // No contact is set: the button is there and says that support is not there yet.
    expect(screen.getByRole('button', { name: ru.support.soon })).toBeDisabled();
    expect(screen.queryByRole('button', { name: new RegExp(ru.chart.teaserCta) })).not.toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toHaveAttribute('value', '40');
  });
});

describe('ReportScreen: a report that is over', () => {
  it('ready: every chapter in the server\'s order, a chapter under an unknown key among them, and a contents list', async () => {
    const extra = { key: 'karma', title: 'Восьмая глава', body_md: 'Текст главы, о которой эта сборка не знает.', order: 7 };
    const [first, second] = sections;
    const { analytics } = setup({ answer: { ...ready, sections: first && second ? [first, second, extra] : [] } });

    await screen.findByRole('region', { name: 'Восьмая глава' });
    expect(screen.getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent)).toEqual([
      copy.contents,
      'Ядро личности',
      'Эмоции и внутренний мир',
      'Восьмая глава',
    ]);
    expect(within(screen.getByRole('navigation', { name: copy.contents })).getAllByRole('button')).toHaveLength(3);
    // No link, no button: the server gave no PDF.
    expect(screen.queryByRole('button', { name: copy.pdf })).not.toBeInTheDocument();
    expect(analytics.events).toEqual([{ name: 'report_ready_view', props: { report_id: REPORT_ID } }]);
  });

  it('ready with a PDF link: offers to download it', async () => {
    setup({ answer: { ...ready, pdf_url: '/api/v1/reports/x/report.pdf?sig=1' } });

    expect(await screen.findByRole('button', { name: copy.pdf })).toBeEnabled();
  });

  it('refunded is not an error: the stars are back, and the screen says exactly that', async () => {
    const { container } = setup({ answer: { ...report, status: 'refunded', is_paid: false, progress: 35 } });

    expect(await screen.findByRole('heading', { name: copy.refundedTitle })).toBeInTheDocument();
    expect(copy.refundedTitle).toContain('звёзды вернулись');
    expect(container.textContent).not.toMatch(/ошибк/i);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: copy.retry })).toBeEnabled();
    expect(screen.getByRole('button', { name: ru.support.soon })).toBeInTheDocument();
  });

  it('unpaid: the opening the server gives out, the way to the paywall, and not a word of the chapters in the DOM', async () => {
    // More than the server ever sends for an unpaid report. The screen must not draw it even so.
    const { container, onPaymentRequired, user } = setup({ answer: { ...ready, is_paid: false, teaser: 'Начало первой главы.' } });

    expect(await screen.findByText('Начало первой главы.')).toBeInTheDocument();
    for (const section of sections) {
      expect(container.innerHTML).not.toContain(section.body_md);
      expect(container.innerHTML).not.toContain(section.title);
    }
    await user.click(screen.getByRole('button', { name: new RegExp(ru.chart.teaserCta) }));
    expect(onPaymentRequired).toHaveBeenCalledWith(false);
  });
});

describe('ReportScreen: the order', () => {
  const idle = { reportId: null } satisfies Partial<ReportScreenProps>;
  const order = () => screen.getByRole('button', { name: copy.order });

  it('names the chart and carries an idempotency key; a repeated tap carries the same key', async () => {
    const api = fakeApi();
    api.orderReport.mockRejectedValueOnce(apiError('NETWORK'));
    const { analytics, user } = setup({ api, props: idle });

    await user.click(order());
    await user.click(await screen.findByRole('button', { name: ru.common.retry }));
    await screen.findByRole('heading', { level: 1, name: copy.queuedTitle });

    expect(api.orderReport).toHaveBeenCalledTimes(2);
    for (const [body, key] of api.orderReport.mock.calls) {
      expect(body).toEqual({ chart_id: chart.chart_id, type: 'full' });
      expect(key).toBe('key-1');
    }
    // The answer to the order gives the id; what the report is like is asked next, at once.
    expect(api.getReport).toHaveBeenCalledWith(REPORT_ID, expect.any(AbortSignal));
    expect(analytics.names()).toEqual(['report_requested', 'error_shown', 'report_requested']);
  });

  it('takes a new key only when the user orders again after a failed report', async () => {
    const api = fakeApi();
    api.getReport.mockResolvedValue({ ...report, status: 'failed', progress: 31 });
    const { analytics, user } = setup({ api, props: idle });

    await user.click(order());
    expect(await screen.findByRole('alert')).toHaveTextContent(copy.failedTitle);
    // For support: the report it was. A failed report is not a failed request, so there is no request id to show.
    expect(screen.getByRole('button', { name: copy.reportId(REPORT_ID) })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: copy.retry }));
    await pass(0);

    expect(api.orderReport.mock.calls.map(([, key]) => key)).toEqual(['key-1', 'key-2']);
    expect(analytics.events).toContainEqual({ name: 'error_shown', props: { screen: 'report', code: 'report_failed' } });
  });

  it('402: on to the paywall, with the reason; right after a purchase the payment is «being processed» instead', async () => {
    const api = fakeApi();
    api.orderReport.mockRejectedValue(apiError('PAYMENT_REQUIRED', { status: 402 }));
    const first = setup({ api, props: idle });

    await first.user.click(order());
    await pass(0);
    expect(first.onPaymentRequired).toHaveBeenCalledWith(true);
    expect(first.analytics.names()).toEqual(['report_requested', 'quota_exhausted']);
    first.unmount();

    const second = setup({ api, props: { reportId: null, orderAtOnce: true, justPaid: true } });
    expect(await screen.findByText(ru.paywall.processingTitle)).toBeInTheDocument();
    expect(second.onPaymentRequired).not.toHaveBeenCalled();
  });

  it('422: the server\'s words about the field and the request id; 429: «a minute»; 409: the server\'s message as it is', async () => {
    const api = fakeApi();
    api.orderReport
      .mockRejectedValueOnce(rejection({ field: 'chart_id', message: 'Выбери карту, по которой нужен разбор' }))
      .mockRejectedValueOnce(apiError('RATE_LIMITED', { status: 429, serverMessage: 'Слишком много запросов. Попробуй через минуту.' }))
      .mockRejectedValueOnce(apiError('CONFLICT', { status: 409, serverMessage: 'Разбор по этой карте уже заказан.' }));

    const invalid = setup({ api, props: idle });
    await invalid.user.click(order());
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(copy.orderRejectedTitle);
    expect(alert).toHaveTextContent('Выбери карту, по которой нужен разбор');
    expect(screen.getByRole('button', { name: new RegExp('req-422') })).toBeInTheDocument();
    invalid.unmount();

    const limited = setup({ api, props: idle });
    await limited.user.click(order());
    expect(await screen.findByRole('alert')).toHaveTextContent(copy.rateLimited);
    limited.unmount();

    const conflict = setup({ api, props: idle });
    await conflict.user.click(order());
    expect(await screen.findByRole('alert')).toHaveTextContent('Разбор по этой карте уже заказан.');
    expect(conflict.onPaymentRequired).not.toHaveBeenCalled();
  });
});
