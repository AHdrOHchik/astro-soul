import * as bridge from '../../telegram';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { ChartResult, FieldError } from '../../api';
import { ru } from '../../i18n/ru';
import {
  apiError,
  chart,
  chartRequest as request,
  chartResult,
  chartWithoutTime,
  cataloguePlans,
  deferred,
  fakeAnalytics,
  fakeApi,
  fakeTelegram,
  rejection,
  report as reportFixture,
  REPORT_ID,
  sections,
} from '../../test/fixtures';
import { formatDayMonthOf } from '../../i18n/format';
import type { ReportAccessState } from '../../lib/reportAccess';
import { ChartScreen, type ChartReportProps } from './ChartScreen';

const copy = ru.chart;
const WHEEL_URL = `https://api.test/api/v1/charts/${chart.chart_id}/wheel.svg?sig=test-signature`;
const TEASER_CTA = copy.teaserCta;
const TEASER_CTA_NAME = `${TEASER_CTA} 149 звёзд`;

interface SetupOptions {
  /** What `POST /charts` answers with; the fixture chart by default. */
  result?: ChartResult | Promise<ChartResult>;
  /** Opens the chart the user already has instead of building one: what `GET /charts/current` answers with, null for «none». */
  current?: ChartResult | null;
  inlineShare?: boolean;
  linkShare?: boolean;
  openLinkShare?: boolean;
  /** An API prepared by the test, e.g. one that fails first. */
  api?: ReturnType<typeof fakeApi>;
  /** False: nobody listens for the fields the server rejected. */
  listens?: boolean;
  /** Renders as a development build does: every effect runs twice, the first run cancelled at once. */
  strict?: boolean;
  /** What the app knows about the user's full report; by default nothing is bought and no report is known. */
  report?: Partial<ChartReportProps>;
}

/** The full report as the chart screen of a user the server says has no access to it sees it. */
const NO_REPORT: ChartReportProps = {
  access: { status: 'none' },
  reportId: null,
  onBuy: vi.fn(),
  onOrder: vi.fn(),
  onOpen: vi.fn(),
};

/** The same for a user whose report is open: by a purchase of this chart, or by a right for any chart. */
const OPEN_REPORT: ReportAccessState = { status: 'open', source: 'purchased', expiresAt: null, chartId: chart.chart_id };

function setup({ result, current, inlineShare = true, linkShare = true, openLinkShare = true, api = fakeApi(), listens = true, strict = false, report }: SetupOptions = {}) {
  if (result) api.createChart.mockImplementation(() => Promise.resolve(result));
  if (current !== undefined) api.getCurrentChart.mockResolvedValue(current);
  const telegram = fakeTelegram({ canSwitchInlineQuery: inlineShare, canOpenTelegramLink: linkShare, canOpenLink: openLinkShare });
  const analytics = fakeAnalytics();
  const onEdit = vi.fn();
  const onRejected = vi.fn<(errors: FieldError[]) => void>();
  const onMissing = vi.fn();
  const reportProps = { ...NO_REPORT, onBuy: vi.fn<ChartReportProps['onBuy']>(), ...report };
  const chartScreen = (
    <ChartScreen
      api={api}
      telegram={telegram}
      request={current === undefined ? request : null}
      apiBaseUrl="https://api.test"
      track={analytics.track}
      onEdit={onEdit}
      onRejected={listens ? onRejected : undefined}
      onMissing={onMissing}
      report={reportProps}
      onOpenSettings={vi.fn()}
    />
  );
  const view = render(strict ? <StrictMode>{chartScreen}</StrictMode> : chartScreen);
  return { api, telegram, analytics, onEdit, onRejected, onMissing, report: reportProps, user: userEvent.setup(), ...view };
}

/** A reading and a wheel path as the client hands them over when the answer carried neither. */
async function chooseInlineShare(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: copy.share }));
  await user.click(await screen.findByRole('button', { name: ru.shareCard.inline }));
}

const NOTHING_BESIDES_THE_CHART = {
  mini_reading: { sun: '', moon: '', asc: '', summary: '' },
  wheel_url: '',
  wheel_png_url: '',
  warnings: [],
  is_restored: false,
};

/** The labelled region of one of the three headline cards. */
const card = (title: string) => screen.getByRole('region', { name: title });

describe('ChartScreen', () => {
  it('shows a skeleton while the chart is being built, then the chart', async () => {
    const pending = deferred<ChartResult>();
    const { api } = setup({ result: pending.promise });

    expect(screen.getByRole('main', { name: copy.title })).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('status')).toHaveTextContent(copy.loading);
    expect(screen.getByRole('heading', { level: 1 })).toHaveFocus();
    expect(api.createChart).toHaveBeenCalledWith(request, expect.any(AbortSignal));
    expect(api.createChart.mock.calls[0]?.[0]).toBe(request);

    pending.resolve(chartResult);

    expect(await screen.findByRole('img', { name: copy.wheelAlt })).toHaveAttribute('src', WHEEL_URL);
    expect(screen.getByRole('main')).not.toHaveAttribute('aria-busy');
    expect(screen.getByText('17 мая 1994 г. · 14:30 · Казань')).toBeInTheDocument();
    expect(api.createChart).toHaveBeenCalledTimes(1);
  });

  it('shows the Sun, Moon and Ascendant with positions from the chart and texts from the mini reading', async () => {
    setup();

    const sun = within(await screen.findByRole('region', { name: copy.sun }));
    expect(sun.getByText(/Телец, 26°17′/)).toBeInTheDocument();
    expect(sun.getByText(copy.house(9), { exact: false })).toBeInTheDocument();
    expect(sun.getByText('Текст про Солнце.')).toBeInTheDocument();

    const moon = within(card(copy.moon));
    expect(moon.getByText(/Рак, 3°05′/)).toBeInTheDocument();
    expect(moon.getByText('Текст про Луну.')).toBeInTheDocument();

    const asc = within(card(copy.asc));
    expect(asc.getByText('Дева, 4°09′')).toBeInTheDocument();
    expect(asc.getByText('Текст про Асцендент.')).toBeInTheDocument();
  });

  it('notifies once for a completed build, not on opening a saved chart', async () => {
    const feedback = vi.spyOn(bridge, 'haptic');
    const first = setup({ strict: true });
    await screen.findByRole('img', { name: copy.wheelAlt });
    first.unmount();
    setup({ current: chartResult });
    await screen.findByRole('img', { name: copy.wheelAlt });
    expect(feedback.mock.calls).toEqual([['success']]);
  });

  it('discloses even a lone non-headline planet without a wheel or known birth time', async () => {
    const result = { ...NOTHING_BESIDES_THE_CHART, chart: { ...chartWithoutTime.chart, planets: chart.planets.filter((p) => p.key === 'mercury') } };
    const { user } = setup({ result });
    const summary = await screen.findByText(copy.planetPositions);
    expect(summary.closest('details')).not.toHaveAttribute('open');
    await user.click(summary);
    const rows = within(screen.getByRole('list')).getAllByRole('listitem');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent('Меркурий: Близнецы, 11°40′');
    expect(rows[0]).not.toHaveTextContent('дом');
  });

  it('marks the Ascendant and houses as not calculated when the birth time is unknown', async () => {
    setup({ result: chartWithoutTime });

    const asc = within(await screen.findByRole('region', { name: copy.asc }));
    expect(asc.getByText(copy.ascUnknown)).toBeInTheDocument();
    expect(asc.getByText(copy.ascUnknownText)).toBeInTheDocument();
    expect(within(card(copy.sun)).getByText('Телец, 26°17′')).toBeInTheDocument();
    expect(screen.queryByText(/-й дом/)).not.toBeInTheDocument();
    expect(screen.getByText(`17 мая 1994 г. · ${copy.timeUnknown} · Казань`)).toBeInTheDocument();
  });

  it('does not show an Ascendant the server sent by mistake for an unknown time', async () => {
    const result: ChartResult = {
      ...chartWithoutTime,
      chart: { ...chartWithoutTime.chart, asc: { sign: 'Дева', degree: 4, minute: 9 } },
    };
    setup({ result });
    expect(within(await screen.findByRole('region', { name: copy.asc })).getByText(copy.ascUnknown)).toBeInTheDocument();
    expect(screen.queryByText(/Дева/)).not.toBeInTheDocument();
  });

  it('shows the unknown-time text of the app in the Ascendant card, not the line the server sends for it', async () => {
    setup({ result: chartWithoutTime });

    const asc = within(await screen.findByRole('region', { name: copy.asc }));
    expect(asc.getByText(copy.ascUnknownText)).toBeInTheDocument();
    expect(screen.queryByText(chartWithoutTime.mini_reading.asc)).not.toBeInTheDocument();
  });

  describe('a chart built before `birth.time_precision` existed', () => {
    const { time_precision: _unknown, ...legacyUnknown } = chartWithoutTime.chart.birth;

    it('reads `time_known: false` as an unknown time', async () => {
      setup({ result: { ...chartWithoutTime, chart: { ...chartWithoutTime.chart, birth: legacyUnknown } } });

      expect(within(await screen.findByRole('region', { name: copy.asc })).getByText(copy.ascUnknown)).toBeInTheDocument();
      expect(screen.getByText(`17 мая 1994 г. · ${copy.timeUnknown} · Казань`)).toBeInTheDocument();
    });

    it('reads a null Ascendant as an unknown time when there is no `time_known` flag either', async () => {
      const { time_known: _flag, ...birth } = legacyUnknown;
      setup({ result: { ...chartWithoutTime, chart: { ...chartWithoutTime.chart, birth } } });

      expect(within(await screen.findByRole('region', { name: copy.asc })).getByText(copy.ascUnknown)).toBeInTheDocument();
    });
  });

  it('does not blame the birth time when the Ascendant is missing although the time is known', async () => {
    setup({ result: { ...chartResult, chart: { ...chart, asc: null } } });

    const asc = within(await screen.findByRole('region', { name: copy.asc }));
    expect(asc.getByText(copy.noPosition)).toBeInTheDocument();
    expect(asc.queryByText(copy.ascUnknown)).not.toBeInTheDocument();
    expect(screen.getByText('17 мая 1994 г. · 14:30 · Казань')).toBeInTheDocument();
  });

  it('shows what the server warns about, in its order, and adds no warning of its own', async () => {
    // The chart says «the time is approximate»; the server warns about the place only.
    const roughly: ChartResult = { ...chartResult, chart: { ...chart, birth: { ...chart.birth, time_precision: 'approximate' } } };
    const { rerender } = setup({ result: { ...roughly, warnings: ['approximate_place', 'no_birth_time'] } });

    await screen.findByRole('region', { name: copy.sun });
    expect(screen.getAllByRole('note').map((note) => note.textContent)).toEqual([
      copy.warnings.approximate_place,
      copy.warnings.no_birth_time,
    ]);
    // An approximate time is still a time: the Ascendant is shown.
    expect(within(card(copy.asc)).getByText('Дева, 4°09′')).toBeInTheDocument();

    // The same chart from a server that warns about nothing, e.g. one built before the warnings existed.
    const api = fakeApi();
    api.createChart.mockResolvedValue(roughly);
    rerender(
      <ChartScreen
        api={api}
        telegram={fakeTelegram()}
        request={{ ...request }}
        apiBaseUrl=""
        track={vi.fn()}
        onEdit={vi.fn()}
        report={NO_REPORT}
        onOpenSettings={vi.fn()}
      />,
    );
    await screen.findByRole('region', { name: copy.sun });
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
  });

  describe('the full report', () => {
    const teaserBlock = async () => within(await screen.findByRole('region', { name: copy.teaserTitle }));

    it('puts the report action after the first chart point and before sharing', async () => {
      setup();
      const action = await (await teaserBlock()).findByRole('button', { name: TEASER_CTA_NAME });
      const first = screen.getByRole('heading', { name: copy.sun });
      for (const next of [screen.getByRole('heading', { name: copy.moon }), screen.getByRole('button', { name: copy.share })]) {
        expect(action.compareDocumentPosition(next) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      }
      expect(first.compareDocumentPosition(action) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('before a purchase: no report text is revealed, and the teaser leads to the paywall for this chart', async () => {
      const { api, report, user } = setup();

      const teaser = await teaserBlock();
      expect(await teaser.findByText(copy.teaserLocked)).toBeInTheDocument();
      const cta = await teaser.findByRole('button', { name: TEASER_CTA_NAME });
      expect(cta.textContent).toContain('149');
      expect(cta.textContent).toContain(ru.common.starSign);
      // No report is known: the server is not asked about one.
      expect(api.getReport).not.toHaveBeenCalled();

      await user.click(cta);
      expect(report.onBuy).toHaveBeenCalledWith({ chartId: chart.chart_id });
    });

    it('unpaid: shows the opening the server gives out, and nothing of the chapters is in the DOM, hidden or not', async () => {
      const api = fakeApi();
      // More than the server ever sends for an unpaid report: chapters. The screen must not draw them even so.
      api.getReport.mockResolvedValue({ ...reportFixture, status: 'ready', progress: 100, is_paid: false, teaser: 'Начало первой главы.', sections });
      const { container } = setup({ api, report: { reportId: REPORT_ID } });

      const teaser = await teaserBlock();
      expect(await teaser.findByText('Начало первой главы.')).toBeInTheDocument();
      expect(api.getReport).toHaveBeenCalledWith(REPORT_ID, expect.any(AbortSignal));
      expect(teaser.getByRole('button', { name: TEASER_CTA_NAME })).toBeEnabled();
      for (const section of sections) {
        expect(container.innerHTML).not.toContain(section.body_md);
        expect(container.innerHTML).not.toContain(section.title);
      }
    });

    it('paid and known: says where the report stands and leads to it', async () => {
      const api = fakeApi();
      api.getReport.mockResolvedValue({ ...reportFixture, status: 'generating', progress: 40, sections });
      const { report, user } = setup({ api, report: { access: OPEN_REPORT, reportId: REPORT_ID, onOpen: vi.fn() } });

      const teaser = await teaserBlock();
      expect(await teaser.findByText(copy.reportStates.generating)).toBeInTheDocument();
      expect(teaser.queryByRole('button', { name: TEASER_CTA_NAME })).not.toBeInTheDocument();
      await user.click(teaser.getByRole('button', { name: copy.openReport }));
      expect(report.onOpen).toHaveBeenCalledWith(expect.objectContaining({ chartId: chart.chart_id }), REPORT_ID);
    });

    it('a report the server no longer has (404): not an error, the block is what it is with no report, and the app is told to forget it', async () => {
      const api = fakeApi();
      api.getReport.mockRejectedValue(apiError('NOT_FOUND', { status: 404, requestId: 'req-404' }));
      const onGone = vi.fn();
      const { analytics } = setup({ api, report: { reportId: REPORT_ID, onGone } });

      const teaser = await teaserBlock();
      // Nothing bought and no report: the price, as for any user without a report.
      expect(await teaser.findByRole('button', { name: TEASER_CTA_NAME })).toBeEnabled();
      expect(onGone).toHaveBeenCalledTimes(1);
      expect(onGone).toHaveBeenCalledWith(REPORT_ID);
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(screen.queryByText(/req-404/)).not.toBeInTheDocument();
      expect(analytics.names()).not.toContain('error_shown');
    });

    it('shows a price skeleton on the chart until the catalogue supplies the report price', async () => {
      const pending = deferred<typeof cataloguePlans>();
      const api = fakeApi();
      api.getPlans.mockReturnValue(pending.promise);
      setup({ api });
      const teaser = await teaserBlock();

      expect(teaser.getByRole('status')).toHaveTextContent(ru.paywall.loadingPlans);
      expect(teaser.queryByRole('button', { name: TEASER_CTA_NAME })).not.toBeInTheDocument();
      pending.resolve(cataloguePlans);
      expect(await teaser.findByRole('button', { name: TEASER_CTA_NAME })).toHaveTextContent('149');
      expect(api.getPlans).toHaveBeenCalledTimes(1);
    });

    it('does not show a buy button without the server price and retries a failed catalogue request', async () => {
      const api = fakeApi();
      api.getPlans
        .mockRejectedValueOnce(apiError('INTERNAL', { status: 500 }))
        .mockResolvedValueOnce(cataloguePlans);
      const { user } = setup({ api });
      const teaser = await teaserBlock();

      expect(await teaser.findByRole('alert')).toHaveTextContent(ru.paywall.plansError);
      expect(teaser.queryByRole('button', { name: TEASER_CTA_NAME })).not.toBeInTheDocument();
      await user.click(teaser.getByRole('button', { name: ru.paywall.retryPlans }));
      expect(await teaser.findByRole('button', { name: TEASER_CTA_NAME })).toHaveTextContent('149');
      expect(api.getPlans).toHaveBeenCalledTimes(2);
    });

    it('paid, with no report known: offers to get it, and a report about another chart does not count', async () => {
      const api = fakeApi();
      api.getReport.mockResolvedValue({ ...reportFixture, status: 'ready', chart_id: '00000000-0000-4000-8000-00000000beef' });
      const { report, user } = setup({ api, report: { access: OPEN_REPORT, reportId: REPORT_ID, onOrder: vi.fn() } });

      const teaser = await teaserBlock();
      await user.click(await teaser.findByRole('button', { name: copy.orderReport }));
      expect(report.onOrder).toHaveBeenCalledTimes(1);
      expect(teaser.queryByText(copy.reportStates.ready)).not.toBeInTheDocument();
    });
  });

  describe('the report the server says is open (contract 1.6.19, `Me.report_access`)', () => {
    const UNTIL = '2026-12-12T12:00:00Z';
    const teaserBlock = async () => within(await screen.findByRole('region', { name: copy.teaserTitle }));

    it('open by «всё включено», no report yet: «Получить разбор» and the term, and no price is asked for at all', async () => {
      const api = fakeApi();
      const { report, user } = setup({
        api,
        report: {
          access: { status: 'open', source: 'all_access', expiresAt: UNTIL, chartId: null },
          reportId: null,
          onOrder: vi.fn(),
        },
      });

      const teaser = await teaserBlock();
      expect(await teaser.findByRole('button', { name: copy.orderReport })).toBeInTheDocument();
      expect(teaser.queryByRole('button', { name: TEASER_CTA_NAME })).not.toBeInTheDocument();
      expect(teaser.getByText(copy.accessUntil(formatDayMonthOf(UNTIL)))).toBeInTheDocument();
      expect(api.getPlans).not.toHaveBeenCalled();

      await user.click(teaser.getByRole('button', { name: copy.orderReport }));
      expect(report.onOrder).toHaveBeenCalledTimes(1);
    });

    it('open by a free report from a code: says so, and orders without a price', async () => {
      const api = fakeApi();
      const { report } = setup({
        api,
        report: { access: { status: 'open', source: 'single_report', expiresAt: null, chartId: null }, reportId: null, onOrder: vi.fn() },
      });

      const teaser = await teaserBlock();
      expect(await teaser.findByRole('button', { name: copy.orderReport })).toBeInTheDocument();
      expect(teaser.getByText(copy.accessSingle)).toBeInTheDocument();
      expect(teaser.queryByText(copy.teaserLocked)).not.toBeInTheDocument();
      expect(api.getPlans).not.toHaveBeenCalled();
      expect(report.onOrder).not.toHaveBeenCalled();
    });

    it('no `report_access` in the answer (a server older than 1.6.19): says it cannot tell, offers a refresh, and shows no price', async () => {
      const api = fakeApi();
      const { report, user } = setup({ api, report: { access: { status: 'unknown' }, reportId: null, onRefreshAccess: vi.fn().mockResolvedValue(null) } });

      const teaser = await teaserBlock();
      expect(await teaser.findByRole('alert')).toHaveTextContent(copy.accessUnknown);
      expect(teaser.queryByRole('button', { name: TEASER_CTA_NAME })).not.toBeInTheDocument();
      expect(teaser.queryByRole('button', { name: copy.orderReport })).not.toBeInTheDocument();
      expect(api.getPlans).not.toHaveBeenCalled();

      await user.click(teaser.getByRole('button', { name: copy.refreshAccess }));
      expect(report.onRefreshAccess).toHaveBeenCalledTimes(1);
    });

    it('no access: the price is the server`s, not a number in this build', async () => {
      const api = fakeApi();
      api.getPlans.mockResolvedValue(cataloguePlans.map((plan) => (plan.plan_code === 'one_149' ? { ...plan, stars: 220 } : plan)));
      const { report, user } = setup({ api });

      const cta = await (await teaserBlock()).findByRole('button', { name: new RegExp(`^${TEASER_CTA} 220`) });
      await user.click(cta);
      expect(report.onBuy).toHaveBeenCalledTimes(1);
    });
  });

  it('creates the server wheel card and reports share_sent only after the inline call', async () => {
    const { api, telegram, analytics, user } = setup();
    expect(analytics.events).not.toContainEqual(expect.objectContaining({ name: 'share_sent' }));

    await chooseInlineShare(user);

    expect(api.createShareCard).toHaveBeenCalledWith('wheel', expect.any(String));
    expect(telegram.switchInlineQuery).toHaveBeenCalledWith('Мне тут сделали разбор личности — залипательно');
    expect(telegram.openTelegramLink).not.toHaveBeenCalled();
    expect(analytics.events.filter(({ name }) => name === 'share_sent')).toEqual([{ name: 'share_sent', props: { kind: 'wheel', channel: 'inline' } }]);
    // On screen it is still the SVG.
    expect(screen.getByRole('img', { name: copy.wheelAlt })).toHaveAttribute('src', WHEEL_URL);
  });

  it('shares only the exact caption returned by the server, without a bot link or card URL', async () => {
    const { api, telegram, user } = setup();
    api.createShareCard.mockResolvedValue({ url: 'https://private.test/signed.png', share_url: 'https://t.me/astro_soul_bot?start=sh_k7m2p9x4qz', expires_at: '2026-11-16T10:00:00Z', caption: 'Серверная подпись дословно' });

    await chooseInlineShare(user);

    expect(telegram.switchInlineQuery).toHaveBeenCalledWith('Серверная подпись дословно');
    expect(telegram.switchInlineQuery).not.toHaveBeenCalledWith(expect.stringContaining('private.test'));
  });

  it('shares the server wheel caption regardless of whether this response has a PNG field', async () => {
    const withoutPng: ChartResult = { ...chartResult, wheel_png_url: '' };
    const { telegram, user } = setup({ result: withoutPng });

    await chooseInlineShare(user);

    expect(telegram.switchInlineQuery).toHaveBeenCalledWith('Мне тут сделали разбор личности — залипательно');
  });

  it('uses the server share_url fallback when inline sharing is unavailable and records channel link', async () => {
    const { api, telegram, analytics, user } = setup();
    telegram.switchInlineQuery.mockReturnValue(false);
    await chooseInlineShare(user);
    expect(api.createShareCard).toHaveBeenCalledWith('wheel', expect.any(String));
    expect(telegram.switchInlineQuery).toHaveBeenCalledWith('Мне тут сделали разбор личности — залипательно');
    expect(telegram.openTelegramLink).toHaveBeenCalledWith('https://t.me/astro_soul_bot?start=sh_k7m2p9x4qz');
    expect(telegram.share).not.toHaveBeenCalled();
    expect(analytics.events.filter(({ name }) => name === 'share_sent')).toEqual([{ name: 'share_sent', props: { kind: 'wheel', channel: 'link' } }]);
  });

  it('hides the fallback after the server says share_url is null, without sending file url or an event', async () => {
    const api = fakeApi();
    api.createShareCard.mockResolvedValue({ url: 'https://private.test/signed.png?sig=secret', share_url: null, expires_at: '2026-11-16T10:00:00Z', caption: 'Exact caption' });
    const { telegram, analytics, user } = setup({ api });
    telegram.switchInlineQuery.mockReturnValue(false);
    await chooseInlineShare(user);
    expect(api.createShareCard).toHaveBeenCalledWith('wheel', expect.any(String));
    expect(telegram.openTelegramLink).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: copy.share })).toBeInTheDocument();
    expect(screen.getByText(ru.report.shareFailed)).toBeInTheDocument();
    expect(analytics.events.filter(({ name }) => name === 'share_sent')).toEqual([]);
  });

  it('hides sharing without inline support or the Telegram-link bridge, without requesting a card', async () => {
    const api = fakeApi();
    const { telegram } = setup({ inlineShare: false, linkShare: false, openLinkShare: false, api });
    // The host without either sharing path cannot start a card request.
    expect(await screen.findByRole('heading', { name: copy.title })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: copy.share })).not.toBeInTheDocument();
    expect(api.createShareCard).not.toHaveBeenCalled();
    expect(telegram.openTelegramLink).not.toHaveBeenCalled();
  });

  it('shows the error state with the server text and request id, then retries', async () => {
    const api = fakeApi();
    api.createChart
      .mockRejectedValueOnce(apiError('INTERNAL', { status: 500, serverMessage: 'Не получилось построить карту.', requestId: 'req-42' }))
      .mockResolvedValueOnce(chartResult);
    const { user } = setup({ api });

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(ru.errors.INTERNAL.title);
    expect(alert).toHaveTextContent('Не получилось построить карту.');
    expect(screen.getByText(ru.common.requestId('req-42'))).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: ru.common.retry }));

    expect(await screen.findByRole('region', { name: copy.sun })).toBeInTheDocument();
    expect(api.createChart).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('sends the user back to the birth data when the server rejects it, without a pointless retry', async () => {
    const api = fakeApi();
    api.createChart.mockRejectedValue(apiError('VALIDATION_FAILED', { status: 422 }));
    const { user, onEdit, onRejected } = setup({ api });

    expect(await screen.findByRole('alert')).toHaveTextContent(ru.errors.VALIDATION_FAILED.text);
    expect(screen.queryByRole('button', { name: ru.common.retry })).not.toBeInTheDocument();
    // The server named no field, so there is no screen to send the user to.
    expect(onRejected).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: copy.editData }));
    expect(onEdit).toHaveBeenCalledTimes(1);
  });

  describe('when the server names the fields it rejected', () => {
    const fields: FieldError[] = [
      { field: 'birth_date', message: 'Сервис доступен с 18 лет' },
      { field: 'birth_place', message: 'Выбери город рождения из подсказок' },
    ];

    it('hands them to the caller once, and shows the server text itself for as long as it stays on screen', async () => {
      const api = fakeApi();
      api.createChart.mockRejectedValue(rejection(...fields));
      const { onRejected } = setup({ api });

      const alert = await screen.findByRole('alert');

      expect(onRejected).toHaveBeenCalledTimes(1);
      expect(onRejected).toHaveBeenCalledWith(fields);
      expect(alert).toHaveTextContent('Сервис доступен с 18 лет');
      expect(screen.getByText(ru.common.requestId('req-422'))).toBeInTheDocument();
      expect(screen.getByRole('button', { name: copy.editData })).toBeInTheDocument();
    });

    it('reports nothing once the screen has been left: a late answer must not move the user', async () => {
      const pending = deferred<ChartResult>();
      const { onRejected, unmount } = setup({ result: pending.promise });

      unmount();
      await act(async () => {
        pending.reject(rejection(...fields));
        await pending.promise.catch(() => undefined);
      });

      expect(onRejected).not.toHaveBeenCalled();
    });

    it('works without a listener', async () => {
      const api = fakeApi();
      api.createChart.mockRejectedValue(rejection(...fields));
      setup({ api, listens: false });

      expect(await screen.findByRole('alert')).toHaveTextContent('Сервис доступен с 18 лет');
    });
  });

  it('has an empty state for a chart that came back with nothing to show', async () => {
    const empty: ChartResult = { chart: { ...chart, birth: {}, asc: {}, planets: [] }, ...NOTHING_BESIDES_THE_CHART };
    const { api, user } = setup({ result: empty });

    expect(await screen.findByRole('heading', { name: copy.emptyTitle })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(copy.emptyText);
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: copy.sun })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: ru.common.retry }));
    expect(api.createChart).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('button', { name: copy.editData })).toBeInTheDocument();
  });

  it('copes with a response that has positions but no wheel and no texts', async () => {
    setup({ result: { chart, ...NOTHING_BESIDES_THE_CHART } });

    expect(await screen.findByText(copy.wheelMissing)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: copy.share })).toBeInTheDocument();
    expect(within(card(copy.sun)).getByText(/Телец, 26°17′/)).toBeInTheDocument();
    expect(within(card(copy.teaserTitle)).getByRole('button', { name: TEASER_CTA_NAME })).toBeInTheDocument();
  });

  it('says when a headline planet is missing from the response', async () => {
    const result: ChartResult = { ...chartResult, chart: { ...chart, planets: chart.planets.filter((planet) => planet.key !== 'moon') } };
    setup({ result });
    expect(within(await screen.findByRole('region', { name: copy.moon })).getByText(copy.noPosition)).toBeInTheDocument();
  });

  it('keeps the rest of the chart when the wheel picture fails, and can load it again', async () => {
    const { user } = setup();

    fireEvent.error(await screen.findByRole('img', { name: copy.wheelAlt }));

    expect(screen.getByRole('alert')).toHaveTextContent(copy.wheelErrorTitle);
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(card(copy.sun)).toBeInTheDocument();
    // Server-rendered sharing is independent of the inline wheel image.
    expect(screen.getByRole('button', { name: copy.share })).toBeEnabled();

    await user.click(screen.getByRole('button', { name: ru.common.retry }));

    const image = screen.getByRole('img', { name: copy.wheelAlt });
    expect(image).toHaveAttribute('src', WHEEL_URL);
    fireEvent.load(image);
    expect(image).toHaveClass('visible');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: copy.share })).toBeEnabled();
  });

  it('cancels the request when the screen is left', () => {
    const pending = deferred<ChartResult>();
    const { api, unmount } = setup({ result: pending.promise });
    const signal = api.createChart.mock.calls[0]?.[1];
    expect(signal?.aborted).toBe(false);

    unmount();

    expect(signal?.aborted).toBe(true);
  });

  describe('the chart the user already has', () => {
    it('opens it from the server without building anything, and offers the way to enter the data again', async () => {
      const { api, analytics, onEdit, onMissing, user } = setup({ current: { ...chartWithoutTime, is_restored: true } });

      expect(await screen.findByRole('img', { name: copy.wheelAlt })).toHaveAttribute('src', WHEEL_URL);
      expect(screen.getByText(`17 мая 1994 г. · ${copy.timeUnknown} · Казань`)).toBeInTheDocument();
      expect(screen.getByRole('note')).toHaveTextContent(copy.warnings.no_birth_time);
      expect(api.getCurrentChart).toHaveBeenCalledTimes(1);
      expect(api.createChart).not.toHaveBeenCalled();
      expect(onMissing).not.toHaveBeenCalled();
      // Not a request for a chart and not a new chart: nothing else is counted.
      expect(analytics.events).toEqual([{ name: 'chart_restored' }]);

      await user.click(screen.getByRole('button', { name: copy.enterAgain }));
      expect(onEdit).toHaveBeenCalledTimes(1);
    });

    it('tells the caller when the server has no chart, and shows neither a chart nor an error', async () => {
      const { analytics, onMissing } = setup({ current: null, strict: true });

      await vi.waitFor(() => {
        expect(onMissing).toHaveBeenCalledTimes(1);
      });
      expect(screen.getByRole('main')).toHaveAttribute('aria-busy', 'true');
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(analytics.events).toEqual([]);
    });
  });

  describe('product events', () => {
    it('reports a chart that already existed as restored, by the body of the answer', async () => {
      const { analytics } = setup({ result: { ...chartResult, is_restored: true } });

      await screen.findByRole('img', { name: copy.wheelAlt });
      expect(analytics.events).toEqual([{ name: 'chart_requested' }, { name: 'chart_restored' }]);
      // Built from the form: the way back to it is the back button, not a button under the chart.
      expect(screen.queryByRole('button', { name: copy.enterAgain })).not.toBeInTheDocument();
    });

    it('reports the request, then the chart', async () => {
      const pending = deferred<ChartResult>();
      const { analytics } = setup({ result: pending.promise });

      await act(() => Promise.resolve());
      expect(analytics.events).toEqual([{ name: 'chart_requested' }]);

      pending.resolve(chartResult);
      await screen.findByRole('img', { name: copy.wheelAlt });
      expect(analytics.events).toEqual([{ name: 'chart_requested' }, { name: 'chart_created' }]);
    });

    it('reports a failure by its code, and a retry as a new request', async () => {
      const api = fakeApi();
      api.createChart
        .mockRejectedValueOnce(apiError('INTERNAL', { status: 500, serverMessage: 'Не получилось построить карту.', requestId: 'req-42' }))
        .mockResolvedValueOnce(chartResult);
      const { analytics, user } = setup({ api });

      await screen.findByRole('alert');
      expect(analytics.events).toEqual([{ name: 'chart_requested' }, { name: 'chart_failed', props: { code: 'INTERNAL' } }]);

      analytics.clear();
      await user.click(screen.getByRole('button', { name: ru.common.retry }));
      await screen.findByRole('img', { name: copy.wheelAlt });
      expect(analytics.events).toEqual([{ name: 'chart_requested' }, { name: 'chart_created' }]);
    });

    it('keeps the birth data and the chart out of every event', async () => {
      const api = fakeApi();
      api.createChart
        .mockRejectedValueOnce(rejection({ field: 'birth_place', message: 'Выбери город рождения из подсказок' }))
        .mockResolvedValueOnce(chartResult);
      const { analytics, user, rerender } = setup({ api });
      await screen.findByRole('alert');
      // The same screen again, as after the user fixed the data: a new request, this time a chart.
      rerender(
        <ChartScreen
          api={api}
          telegram={fakeTelegram()}
          request={{ ...request }}
          apiBaseUrl="https://api.test"
          track={analytics.track}
          onEdit={vi.fn()}
          report={NO_REPORT}
          onOpenSettings={vi.fn()}
        />,
      );
      await chooseInlineShare(user);

      expect(analytics.names()).toEqual([
        'chart_requested',
        'chart_failed',
        'validation_failed',
        'chart_requested',
        'chart_created',
        'share_clicked',
        'share_sent',
      ]);
      const reported = JSON.stringify(analytics.events);
      expect(reported).not.toMatch(/\p{Script=Cyrillic}/u);
      for (const secret of ['1994', '05-17', '14:30', '55.79', '49.1', 'Europe', chart.chart_id, 'sig=']) {
        expect(reported).not.toContain(secret);
      }
    });
  });
});
