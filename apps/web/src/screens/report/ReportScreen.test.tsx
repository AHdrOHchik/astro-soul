import { act, fireEvent, render, screen, within } from '@testing-library/react';
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
  /** A clock only the test moves: for the tests that count the questions to the millisecond. */
  manualClock?: boolean;
}

function setup({ api = fakeApi(), answer, props, manualClock = false }: SetupOptions = {}) {
  if (answer) api.getReport.mockResolvedValue(answer);
  const telegram = fakeTelegram();
  const analytics = fakeAnalytics();
  const onPaymentRequired = vi.fn<ReportScreenProps['onPaymentRequired']>();
  const user = setupUser({ manual: manualClock });
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
    const { api } = setup({ manualClock: true });

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
    const { api } = setup({ manualClock: true });
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

  it.each([
    ['ready', ready],
    ['failed', { ...report, status: 'failed', progress: 31 }],
    ['refunded', { ...report, status: 'refunded', is_paid: false, progress: 35 }],
  ] satisfies [string, Report][])('asks no more once the report is over (%s): not a minute on, not when the page is shown again', async (_status, answer) => {
    const { api } = setup({ answer, manualClock: true });
    await pass(0);
    expect(api.getReport).toHaveBeenCalledTimes(1);

    await pass(60_000);
    expect(api.getReport).toHaveBeenCalledTimes(1);

    // Coming back to the page is what starts the questions again while a report is in work. Not here.
    setHidden(true);
    await pass(1000);
    setHidden(false);
    await pass(60_000);
    expect(api.getReport).toHaveBeenCalledTimes(1);
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
  it('places the compatibility entry after the completed chapters and opens it for this chart', async () => {
    const onOpenCompatibility = vi.fn();
    const { user } = setup({ answer: ready, props: { onOpenCompatibility, onBuyCompatibility: vi.fn() } });

    const entry = await screen.findByRole('region', { name: ru.compatibility.entryTitle });
    const button = within(entry).getByRole('button', { name: ru.compatibility.entryTitle });
    expect(button).toBeEnabled();
    await user.click(button);
    expect(onOpenCompatibility).toHaveBeenCalledWith(chart.chart_id);
  });
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
    // Counted in an effect, which may run a moment after the chapters are on screen.
    await pass(0);
    expect(analytics.events).toEqual([{ name: 'report_ready_view', props: { report_id: REPORT_ID } }]);
  });

  it('ready with a PDF link: offers to download it', async () => {
    setup({ answer: { ...ready, pdf_url: '/api/v1/reports/x/report.pdf?sig=1' } });

    expect(await screen.findByRole('button', { name: copy.pdf })).toBeEnabled();
  });

  it('refunded is not an error: the stars are back, and the screen says exactly that', async () => {
    const { container } = setup({ answer: { ...report, status: 'refunded', is_paid: false, progress: 35 } });

    expect(await screen.findByRole('heading', { name: copy.refundedTitle })).toBeInTheDocument();
    expect(copy.refundedText).toContain('Повторный запуск доступен без новой оплаты');
    expect(copy.refundedText).toContain('по обращению в поддержку в течение 24 часов');
    expect(copy.refundedText).not.toContain('автоматически');
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

describe('ReportScreen: a report that is gone', () => {
  const gone = apiError('NOT_FOUND', { status: 404, serverMessage: 'Такой страницы нет. Обнови приложение.', requestId: 'req-404' });

  it('known to the app and no longer on the server (404): no error, nothing reported, the app is told to forget it', async () => {
    const api = fakeApi();
    api.getReport.mockRejectedValue(gone);
    const onReportGone = vi.fn();
    const { analytics } = setup({ api, props: { onReportGone } });

    // What the screen is with no report: the way to get one.
    expect(await screen.findByRole('button', { name: copy.order })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByText(/req-404/)).not.toBeInTheDocument();
    expect(onReportGone).toHaveBeenCalledTimes(1);
    expect(onReportGone).toHaveBeenCalledWith(REPORT_ID);
    // Not a failure: no `error_shown`, and the server is not asked about that report again.
    expect(analytics.events).toEqual([]);
    await pass(60_000);
    expect(api.getReport).toHaveBeenCalledTimes(1);
  });

  it('gone while it was on screen: the same, and the chapters go with it', async () => {
    const api = fakeApi();
    api.getReport.mockResolvedValueOnce(generating).mockRejectedValue(gone);
    const onReportGone = vi.fn();
    const { analytics, container } = setup({ api, props: { onReportGone } });
    await screen.findByRole('progressbar');

    await pass(POLL_DELAYS_MS[0]);

    expect(await screen.findByRole('button', { name: copy.order })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    for (const section of sections) expect(container.innerHTML).not.toContain(section.body_md);
    expect(onReportGone).toHaveBeenCalledWith(REPORT_ID);
    expect(analytics.names()).not.toContain('error_shown');
  });

  it('ordered on this screen and not found a moment later: that is a failure, shown with its request id and counted', async () => {
    const api = fakeApi();
    api.getReport.mockRejectedValue(gone);
    const onReportGone = vi.fn();
    const { analytics, user } = setup({ api, props: { reportId: null, onReportGone } });

    await user.click(screen.getByRole('button', { name: copy.order }));

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByText(ru.common.requestId('req-404'))).toBeInTheDocument();
    expect(onReportGone).not.toHaveBeenCalled();
    expect(analytics.events).toContainEqual({ name: 'error_shown', props: { screen: 'report', code: '404' } });
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

  it('a double tap on the order button is one order: one request, one key, and nothing left to tap', async () => {
    const api = fakeApi();
    // The server is slow to answer: both taps land before it does.
    api.orderReport.mockImplementation(() => new Promise<never>(() => undefined));
    setup({ api, props: idle });

    const button = order();
    // Two taps in one tick, before the screen has drawn anything in answer to the first.
    act(() => {
      fireEvent.click(button);
      fireEvent.click(button);
    });
    await pass(0);

    expect(api.orderReport).toHaveBeenCalledTimes(1);
    expect(api.orderReport).toHaveBeenCalledWith({ chart_id: chart.chart_id, type: 'full' }, 'key-1', expect.any(AbortSignal));
    expect(screen.queryByRole('button', { name: copy.order })).not.toBeInTheDocument();
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

  it('503 report breaker open: clear message, retry and support, and only the status is counted', async () => {
    const api = fakeApi();
    api.orderReport.mockRejectedValue(apiError('UPSTREAM_LLM', {
      status: 503,
      details: { reason: 'report_breaker_open' },
      requestId: 'req-breaker',
    }));
    const { analytics, user } = setup({ api, props: { ...idle, supportLink: 'https://t.me/astro_support' } });

    await user.click(order());

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(copy.breakerOpenText);
    const retry = screen.getByRole('button', { name: copy.retry });
    const support = screen.getByRole('button', { name: ru.support.write });
    expect(retry).toBeEnabled();
    expect(support).toBeEnabled();
    expect(analytics.events).toContainEqual({ name: 'error_shown', props: { screen: 'report', code: '503' } });
    expect(JSON.stringify(analytics.events)).not.toContain('req-breaker');
  });

  it('503 with another or missing reason, and ordinary 500, keep their ordinary error text', async () => {
    const api = fakeApi();
    api.orderReport
      .mockRejectedValueOnce(apiError('UPSTREAM_LLM', { status: 503, details: { reason: 'maintenance' } }))
      .mockRejectedValueOnce(apiError('UPSTREAM_LLM', { status: 503 }))
      .mockRejectedValueOnce(apiError('INTERNAL', { status: 500 }));

    const other = setup({ api, props: idle });
    await other.user.click(order());
    expect(await screen.findByRole('alert')).toHaveTextContent(ru.errors.UPSTREAM_LLM.text);
    expect(screen.queryByText(copy.breakerOpenText)).not.toBeInTheDocument();
    other.unmount();

    const empty = setup({ api, props: idle });
    await empty.user.click(order());
    expect(await screen.findByRole('alert')).toHaveTextContent(ru.errors.UPSTREAM_LLM.text);
    expect(screen.queryByText(copy.breakerOpenText)).not.toBeInTheDocument();
    empty.unmount();

    const internal = setup({ api, props: idle });
    await internal.user.click(order());
    expect(await screen.findByRole('alert')).toHaveTextContent(ru.errors.INTERNAL.text);
    expect(screen.queryByText(copy.breakerOpenText)).not.toBeInTheDocument();
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
    // A conflict comes with the way to support, once, and without «retry».
    expect(screen.getAllByRole('button', { name: ru.support.soon })).toHaveLength(1);
    expect(screen.queryByRole('button', { name: ru.common.retry })).not.toBeInTheDocument();
  });
});

describe('ReportScreen: the chart the report is ordered for is gone', () => {
  /** The answer of apps/api to an order for a chart it does not have (`reports.service.ts`). */
  const chartGone = () => apiError('NOT_FOUND', { status: 404, serverMessage: 'Такой карты нет. Построй карту заново', requestId: 'req-404' });
  /** The screen with no report yet: the order is made by the button. */
  const idle = { reportId: null } satisfies Partial<ReportScreenProps>;
  const order = () => screen.getByRole('button', { name: copy.order });

  it('404 to the order: the app leads on, and nothing of the server\'s answer is shown', async () => {
    const api = fakeApi();
    api.orderReport.mockRejectedValue(chartGone());
    const onChartGone = vi.fn();
    const { analytics, onPaymentRequired, user } = setup({ api, props: { ...idle, onChartGone } });

    await user.click(order());
    await pass(0);

    expect(onChartGone).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByText('Такой карты нет. Построй карту заново')).not.toBeInTheDocument();
    expect(screen.queryByText(/req-404/)).not.toBeInTheDocument();
    expect(onPaymentRequired).not.toHaveBeenCalled();
    // Ordered once, never repeated; and nothing failed that the user was shown.
    expect(api.orderReport).toHaveBeenCalledTimes(1);
    expect(analytics.names()).toEqual(['report_requested']);
  });

  it('the same when the order is made as the screen opens, right after a payment', async () => {
    const api = fakeApi();
    api.orderReport.mockRejectedValue(chartGone());
    const onChartGone = vi.fn();
    setup({ api, props: { reportId: null, orderAtOnce: true, justPaid: true, onChartGone } });
    await pass(0);

    expect(onChartGone).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(api.orderReport).toHaveBeenCalledTimes(1);
  });

  it('is not read into a 404 about the report itself: that one is the report that is gone, not the chart', async () => {
    const api = fakeApi();
    api.getReport.mockRejectedValue(apiError('NOT_FOUND', { status: 404, serverMessage: 'Разбор не найден' }));
    const onChartGone = vi.fn();
    const onReportGone = vi.fn();
    setup({ api, props: { onChartGone, onReportGone } });
    await pass(0);

    expect(onReportGone).toHaveBeenCalledWith(REPORT_ID);
    expect(onChartGone).not.toHaveBeenCalled();
  });

  it('is shown like any failure where nobody takes it from the screen', async () => {
    const api = fakeApi();
    api.orderReport.mockRejectedValue(chartGone());
    const { analytics, user } = setup({ api, props: idle });

    await user.click(order());
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(analytics.events).toContainEqual({ name: 'error_shown', props: { screen: 'report', code: '404' } });
  });
});

describe('ReportScreen: no such report on the server, and the question whether the chart went with it (`isChartThere`)', () => {
  /** The answer of apps/api about a report it does not have (`reports.service.ts`). */
  const SERVER_TEXT = 'Такого разбора нет. Обнови приложение';
  const gone = () => apiError('NOT_FOUND', { status: 404, serverMessage: SERVER_TEXT, requestId: 'req-404' });
  const order = () => screen.getByRole('button', { name: copy.order });

  /** The screen says nothing about the report: no failure, no offer to order, not a word of the server's. */
  function expectNothingSaid(analytics: ReturnType<typeof fakeAnalytics>) {
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByText(SERVER_TEXT)).not.toBeInTheDocument();
    expect(screen.queryByText(/req-404/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: copy.order })).not.toBeInTheDocument();
    expect(analytics.names()).not.toContain('error_shown');
  }

  it('a report the app knew of, and the chart is gone too: nothing is shown and nothing is forgotten here, the caller leads on', async () => {
    const api = fakeApi();
    api.getReport.mockRejectedValue(gone());
    const isChartThere = vi.fn<NonNullable<ReportScreenProps['isChartThere']>>().mockResolvedValue(false);
    const onReportGone = vi.fn();
    const { analytics } = setup({ api, props: { isChartThere, onReportGone } });
    await pass(0);

    expect(isChartThere).toHaveBeenCalledTimes(1);
    expectNothingSaid(analytics);
    expect(onReportGone).not.toHaveBeenCalled();
    // And the server is not asked about that report again while the caller takes the user away.
    await pass(60_000);
    expect(api.getReport).toHaveBeenCalledTimes(1);
    expect(isChartThere).toHaveBeenCalledTimes(1);
  });

  it('a report ordered on this screen, deleted with the data while it was being written: the same, and the server\'s words are never shown', async () => {
    const api = fakeApi();
    api.getReport.mockResolvedValueOnce(generating).mockRejectedValue(gone());
    const isChartThere = vi.fn<NonNullable<ReportScreenProps['isChartThere']>>().mockResolvedValue(false);
    const { analytics, user } = setup({ api, props: { reportId: null, isChartThere } });
    await user.click(order());
    await screen.findByRole('progressbar');
    analytics.clear();

    await pass(POLL_DELAYS_MS[0]);

    expect(isChartThere).toHaveBeenCalledTimes(1);
    expectNothingSaid(analytics);
    expect(analytics.events).toEqual([]);
  });

  it('nothing is said while the question is on its way either: the screen stays as it was', async () => {
    const api = fakeApi();
    api.getReport.mockResolvedValueOnce(generating).mockRejectedValue(gone());
    const isChartThere = vi.fn<NonNullable<ReportScreenProps['isChartThere']>>().mockReturnValue(new Promise<boolean>(() => undefined));
    const { analytics } = setup({ api, props: { isChartThere } });
    await screen.findByRole('progressbar');

    await pass(POLL_DELAYS_MS[0]);

    expect(isChartThere).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('progressbar')).toBeInTheDocument();
    expectNothingSaid(analytics);
  });

  it('the chart is there, the report the app knew of is not: forgotten, and the screen offers to get one, as without the question', async () => {
    const api = fakeApi();
    api.getReport.mockRejectedValue(gone());
    const isChartThere = vi.fn<NonNullable<ReportScreenProps['isChartThere']>>().mockResolvedValue(true);
    const onReportGone = vi.fn();
    const { analytics } = setup({ api, props: { isChartThere, onReportGone } });

    expect(await screen.findByRole('button', { name: copy.order })).toBeInTheDocument();
    expect(onReportGone).toHaveBeenCalledWith(REPORT_ID);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(analytics.events).toEqual([]);
    expect(isChartThere).toHaveBeenCalledTimes(1);
  });

  it('the chart is there, the report ordered on this screen is not: a failure, shown and counted, as without the question', async () => {
    const api = fakeApi();
    api.getReport.mockRejectedValue(gone());
    const isChartThere = vi.fn<NonNullable<ReportScreenProps['isChartThere']>>().mockResolvedValue(true);
    const { analytics, user } = setup({ api, props: { reportId: null, isChartThere } });

    await user.click(order());

    expect(await screen.findByRole('alert')).toHaveTextContent(SERVER_TEXT);
    expect(screen.getByText(ru.common.requestId('req-404'))).toBeInTheDocument();
    expect(analytics.events).toContainEqual({ name: 'error_shown', props: { screen: 'report', code: '404' } });
  });

  it.each([
    ['the app knew of', {}, false],
    ['ordered on this screen', { reportId: null }, true],
  ] as const)('a question that failed says nothing about the chart: a report %s is treated as without the question', async (_which, props, ordered) => {
    const api = fakeApi();
    api.getReport.mockRejectedValue(gone());
    const isChartThere = vi.fn<NonNullable<ReportScreenProps['isChartThere']>>().mockRejectedValue(apiError('NETWORK'));
    const onReportGone = vi.fn();
    const { user } = setup({ api, props: { ...props, isChartThere, onReportGone } });
    if (ordered) await user.click(order());
    await pass(0);

    if (ordered) expect(screen.getByRole('alert')).toHaveTextContent(SERVER_TEXT);
    else expect(order()).toBeInTheDocument();
    expect(onReportGone).toHaveBeenCalledTimes(ordered ? 0 : 1);
  });

  it('is asked with a signal that is cancelled when the screen is left: an answer that comes later changes nothing', async () => {
    const api = fakeApi();
    api.getReport.mockRejectedValue(gone());
    let answer: (there: boolean) => void = () => undefined;
    const isChartThere = vi.fn<NonNullable<ReportScreenProps['isChartThere']>>().mockReturnValue(
      new Promise<boolean>((resolve) => {
        answer = resolve;
      }),
    );
    const onReportGone = vi.fn();
    const { analytics, unmount } = setup({ api, props: { isChartThere, onReportGone } });
    await pass(0);
    const signal = isChartThere.mock.calls[0]?.[0];
    expect(signal?.aborted).toBe(false);

    unmount();
    expect(signal?.aborted).toBe(true);
    await act(async () => {
      answer(true);
      await Promise.resolve();
    });
    expect(onReportGone).not.toHaveBeenCalled();
    expect(analytics.events).toEqual([]);
  });

  it('is not asked about any other failure, nor about a report that is there', async () => {
    const api = fakeApi();
    api.getReport.mockRejectedValueOnce(apiError('INTERNAL', { status: 500 })).mockResolvedValue(ready);
    const isChartThere = vi.fn<NonNullable<ReportScreenProps['isChartThere']>>().mockResolvedValue(false);
    const { user } = setup({ api, props: { isChartThere } });

    await user.click(await screen.findByRole('button', { name: ru.common.retry }));
    expect(await screen.findByText(sections[0]?.body_md ?? '')).toBeInTheDocument();
    expect(isChartThere).not.toHaveBeenCalled();
  });

  describe('the PDF of a report that is on screen', () => {
    const withPdf: Report = { ...ready, pdf_url: '/api/v1/reports/x/report.pdf?sig=1' };

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    /** The link, checked before it is opened, answers as the server says. */
    function linkAnswers(status: number) {
      const check = vi.fn<(url: string, init?: RequestInit) => Promise<Pick<Response, 'status'>>>().mockResolvedValue({ status });
      vi.stubGlobal('fetch', check);
      return check;
    }

    it('the link is gone and so is the report: the chart is asked about, and the screen says only that the PDF is not available', async () => {
      const check = linkAnswers(404);
      const api = fakeApi();
      api.getReport.mockResolvedValueOnce(withPdf).mockRejectedValue(gone());
      const isChartThere = vi.fn<NonNullable<ReportScreenProps['isChartThere']>>().mockResolvedValue(false);
      const { telegram, user } = setup({ api, props: { isChartThere } });

      await user.click(await screen.findByRole('button', { name: copy.pdf }));

      expect(check).toHaveBeenCalledWith('https://api.test/api/v1/reports/x/report.pdf?sig=1', { method: 'HEAD' });
      expect(isChartThere).toHaveBeenCalledTimes(1);
      expect(await screen.findByText(copy.pdfUnavailable)).toBeInTheDocument();
      expect(screen.queryByText(SERVER_TEXT)).not.toBeInTheDocument();
      expect(telegram.openLink).not.toHaveBeenCalled();
    });

    it('a link that opens asks nothing; one that expired is asked for again, and the chart is not in question', async () => {
      const check = linkAnswers(200);
      const api = fakeApi();
      api.getReport.mockResolvedValueOnce(withPdf).mockResolvedValue({ ...withPdf, pdf_url: '/api/v1/reports/x/report.pdf?sig=2' });
      const isChartThere = vi.fn<NonNullable<ReportScreenProps['isChartThere']>>().mockResolvedValue(false);
      const { telegram, user } = setup({ api, props: { isChartThere } });

      await user.click(await screen.findByRole('button', { name: copy.pdf }));
      expect(telegram.openLink).toHaveBeenLastCalledWith('https://api.test/api/v1/reports/x/report.pdf?sig=1');

      check.mockResolvedValue({ status: 404 });
      await user.click(screen.getByRole('button', { name: copy.pdf }));
      expect(telegram.openLink).toHaveBeenLastCalledWith('https://api.test/api/v1/reports/x/report.pdf?sig=2');
      expect(isChartThere).not.toHaveBeenCalled();
    });
  });
});
