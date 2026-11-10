import { priceOf } from '@astro-soul/shared';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { Chart, ChartResult, FieldError, TimePrecision } from '../../api';
import { formatCount, pluralForm } from '../../i18n/format';
import { ru } from '../../i18n/ru';
import {
  apiError,
  chart,
  chartRequest as request,
  chartResult,
  chartWithoutTime,
  deferred,
  fakeApi,
  fakeTelegram,
  rejection,
} from '../../test/fixtures';
import { ChartScreen } from './ChartScreen';

const copy = ru.chart;
const WHEEL_URL = `https://api.test/api/v1/charts/${chart.chart_id}/wheel.svg?sig=test-signature`;
// The price is whatever packages/shared says, so a price change there needs no edit here.
const REPORT_PRICE = priceOf('one_149');
const TEASER_CTA = `${copy.teaserCta} ${formatCount(REPORT_PRICE)}`;
/** What a screen reader gets: the star sign is replaced with the word. */
const TEASER_CTA_NAME = `${TEASER_CTA} ${ru.common.stars[pluralForm(REPORT_PRICE)]}`;

function setup(options: { result?: ChartResult | Promise<ChartResult> } = {}) {
  const api = fakeApi();
  if (options.result) api.createChart.mockImplementation(() => Promise.resolve(options.result ?? chartResult));
  const telegram = fakeTelegram();
  const onEdit = vi.fn();
  const onRejected = vi.fn<(errors: FieldError[]) => void>();
  const view = render(
    <ChartScreen api={api} telegram={telegram} request={request} apiBaseUrl="https://api.test" onEdit={onEdit} onRejected={onRejected} />,
  );
  return { api, telegram, onEdit, onRejected, user: userEvent.setup(), ...view };
}

/** The fixture chart with another `birth` block. */
const chartBornWith = (birth: Chart['birth'], rest: Partial<Chart> = {}): ChartResult => ({
  ...chartResult,
  chart: { ...chart, ...rest, birth },
});

/** A reading and a wheel path as the client hands them over when the answer carried neither. */
const NOTHING_BESIDES_THE_CHART = { mini_reading: { sun: '', moon: '', asc: '', summary: '' }, wheel_url: '' };

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

  it('marks the Ascendant and houses as not calculated when the birth time is unknown', async () => {
    setup({ result: chartWithoutTime });

    const asc = within(await screen.findByRole('region', { name: copy.asc }));
    expect(asc.getByText(copy.ascUnknown)).toBeInTheDocument();
    expect(asc.getByText(copy.ascUnknownText)).toBeInTheDocument();
    expect(within(card(copy.sun)).getByText('Телец, 26°17′')).toBeInTheDocument();
    expect(screen.queryByText(/-й дом/)).not.toBeInTheDocument();
    expect(screen.getByText(`17 мая 1994 г. · ${copy.timeUnknown} · Казань`)).toBeInTheDocument();
    // The Moon is shown to the minute of arc; without a time that precision is not real.
    expect(screen.getByText(copy.unknownTime)).toBeInTheDocument();
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
    const { time_precision: _precision, ...legacyKnown } = chart.birth;
    const { time_precision: _unknown, ...legacyUnknown } = chartWithoutTime.chart.birth;

    it('reads `time_known: false` as an unknown time', async () => {
      setup({ result: { ...chartWithoutTime, chart: { ...chartWithoutTime.chart, birth: legacyUnknown } } });

      expect(within(await screen.findByRole('region', { name: copy.asc })).getByText(copy.ascUnknown)).toBeInTheDocument();
      expect(screen.getByText(copy.unknownTime)).toBeInTheDocument();
      expect(screen.getByText(`17 мая 1994 г. · ${copy.timeUnknown} · Казань`)).toBeInTheDocument();
    });

    it('reads a null Ascendant as an unknown time when there is no `time_known` flag either', async () => {
      const { time_known: _flag, ...birth } = legacyUnknown;
      setup({ result: { ...chartWithoutTime, chart: { ...chartWithoutTime.chart, birth } } });

      expect(within(await screen.findByRole('region', { name: copy.asc })).getByText(copy.ascUnknown)).toBeInTheDocument();
      expect(screen.getByText(copy.unknownTime)).toBeInTheDocument();
    });

    it('claims nothing about the accuracy of a time it knows only as "known"', async () => {
      setup({ result: chartBornWith(legacyKnown) });

      expect(within(await screen.findByRole('region', { name: copy.asc })).getByText('Дева, 4°09′')).toBeInTheDocument();
      expect(screen.queryByText(copy.approxTime)).not.toBeInTheDocument();
      expect(screen.queryByText(copy.unknownTime)).not.toBeInTheDocument();
    });
  });

  it('does not blame the birth time when the Ascendant is missing although the time is known', async () => {
    setup({ result: { ...chartResult, chart: { ...chart, asc: null } } });

    const asc = within(await screen.findByRole('region', { name: copy.asc }));
    expect(asc.getByText(copy.noPosition)).toBeInTheDocument();
    expect(asc.queryByText(copy.ascUnknown)).not.toBeInTheDocument();
    expect(screen.queryByText(copy.unknownTime)).not.toBeInTheDocument();
    expect(screen.getByText('17 мая 1994 г. · 14:30 · Казань')).toBeInTheDocument();
  });

  it('reminds about the accuracy when the chart says the time was given roughly', async () => {
    setup({ result: chartBornWith({ ...chart.birth, time_precision: 'approximate' }) });

    expect(await screen.findByText(copy.approxTime)).toBeInTheDocument();
    expect(screen.queryByText(copy.unknownTime)).not.toBeInTheDocument();
    // An approximate time is still a time: the Ascendant is shown.
    expect(within(card(copy.asc)).getByText('Дева, 4°09′')).toBeInTheDocument();
  });

  it.each<[TimePrecision, string | null]>([
    ['exact', null],
    ['approximate', copy.approxTime],
    ['unknown', copy.unknownTime],
  ])('takes the precision from the chart, not from the other signs of a time: %s', async (precision, note) => {
    // Everything else says "the time is known".
    setup({ result: chartBornWith({ ...chart.birth, time_precision: precision }) });
    await screen.findByRole('region', { name: copy.sun });

    for (const text of [copy.approxTime, copy.unknownTime]) {
      expect(screen.queryAllByText(text)).toHaveLength(text === note ? 1 : 0);
    }
  });

  it('shows no accuracy note for an exact time', async () => {
    setup();
    await screen.findByRole('region', { name: copy.sun });
    expect(screen.queryByText(copy.approxTime)).not.toBeInTheDocument();
    expect(screen.queryByText(copy.unknownTime)).not.toBeInTheDocument();
  });

  it('keeps the full report locked: a teaser, the price from the shared plans, and a button that cannot start a purchase yet', async () => {
    setup();

    const teaser = within(await screen.findByRole('region', { name: copy.teaserTitle }));
    expect(teaser.getByText('Начало полного разбора.')).toBeInTheDocument();
    expect(teaser.getByText(copy.teaserLocked)).toBeInTheDocument();
    const cta = teaser.getByRole('button', { name: TEASER_CTA_NAME });
    expect(cta).toBeDisabled();
    // What is on the screen. Read from the node: toHaveTextContent replaces non-breaking spaces with plain ones.
    expect(cta.textContent).toContain(`${TEASER_CTA} ${ru.common.starSign}`);
    expect(cta).toHaveAccessibleDescription(copy.teaserSoon);
  });

  it('shares the signed wheel link through Telegram', async () => {
    const { telegram, user } = setup();

    await user.click(await screen.findByRole('button', { name: copy.share }));

    expect(telegram.share).toHaveBeenCalledWith(WHEEL_URL, copy.shareText);
  });

  it('shows the error state with the server text and request id, then retries', async () => {
    const api = fakeApi();
    api.createChart
      .mockRejectedValueOnce(apiError('INTERNAL', { status: 500, serverMessage: 'Не получилось построить карту.', requestId: 'req-42' }))
      .mockResolvedValueOnce(chartResult);
    const user = userEvent.setup();
    render(<ChartScreen api={api} telegram={fakeTelegram()} request={request} apiBaseUrl="" onEdit={vi.fn()} />);

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
    const onEdit = vi.fn();
    const onRejected = vi.fn();
    const user = userEvent.setup();
    render(<ChartScreen api={api} telegram={fakeTelegram()} request={request} apiBaseUrl="" onEdit={onEdit} onRejected={onRejected} />);

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
      const onRejected = vi.fn();
      render(<ChartScreen api={api} telegram={fakeTelegram()} request={request} apiBaseUrl="" onEdit={vi.fn()} onRejected={onRejected} />);

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
      render(<ChartScreen api={api} telegram={fakeTelegram()} request={request} apiBaseUrl="" onEdit={vi.fn()} />);

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
    expect(screen.queryByRole('button', { name: copy.share })).not.toBeInTheDocument();
    expect(within(card(copy.sun)).getByText(/Телец, 26°17′/)).toBeInTheDocument();
    expect(within(card(copy.teaserTitle)).getByRole('button', { name: TEASER_CTA_NAME })).toBeDisabled();
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
    // The link to a picture that does not open is not offered for sharing.
    expect(screen.getByRole('button', { name: copy.share })).toBeDisabled();

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
});
