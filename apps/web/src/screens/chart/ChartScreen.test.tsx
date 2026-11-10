import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { ChartCreateRequest, ChartResult } from '../../api';
import { ru } from '../../i18n/ru';
import { apiError, chart, chartResult, chartWithoutTime, deferred, fakeApi, fakeTelegram, kazan } from '../../test/fixtures';
import { ChartScreen } from './ChartScreen';

const copy = ru.chart;
const request: ChartCreateRequest = { birth_date: '1994-05-17', birth_time: '14:30', birth_place: kazan };
const WHEEL_URL = `https://api.test/api/v1/charts/${chart.chart_id}/wheel.svg?sig=test-signature`;

function setup(options: { result?: ChartResult | Promise<ChartResult>; timeApproximate?: boolean } = {}) {
  const api = fakeApi();
  if (options.result) api.createChart.mockImplementation(() => Promise.resolve(options.result ?? chartResult));
  const telegram = fakeTelegram();
  const onEdit = vi.fn();
  const view = render(
    <ChartScreen
      api={api}
      telegram={telegram}
      request={request}
      apiBaseUrl="https://api.test"
      timeApproximate={options.timeApproximate ?? false}
      onEdit={onEdit}
    />,
  );
  return { api, telegram, onEdit, user: userEvent.setup(), ...view };
}

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

  it('reminds about the accuracy when the time was given roughly', async () => {
    setup({ timeApproximate: true });
    expect(await screen.findByText(copy.approxTime)).toBeInTheDocument();
    expect(screen.queryByText(copy.unknownTime)).not.toBeInTheDocument();
  });

  it('shows no accuracy note for an exact time', async () => {
    setup();
    await screen.findByRole('region', { name: copy.sun });
    expect(screen.queryByText(copy.approxTime)).not.toBeInTheDocument();
    expect(screen.queryByText(copy.unknownTime)).not.toBeInTheDocument();
  });

  it('keeps the full report locked: a teaser, no price, and a button that cannot start a purchase yet', async () => {
    setup();

    const teaser = within(await screen.findByRole('region', { name: copy.teaserTitle }));
    expect(teaser.getByText('Начало полного разбора.')).toBeInTheDocument();
    expect(teaser.getByText(copy.teaserLocked)).toBeInTheDocument();
    expect(teaser.getByRole('button', { name: copy.teaserCta })).toBeDisabled();
    expect(teaser.getByText(copy.teaserSoon)).toBeInTheDocument();
    expect(screen.queryByText(/⭐|XTR|\d+\s*звёзд/)).not.toBeInTheDocument();
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
    render(<ChartScreen api={api} telegram={fakeTelegram()} request={request} apiBaseUrl="" timeApproximate={false} onEdit={vi.fn()} />);

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
    const user = userEvent.setup();
    render(<ChartScreen api={api} telegram={fakeTelegram()} request={request} apiBaseUrl="" timeApproximate={false} onEdit={onEdit} />);

    expect(await screen.findByRole('alert')).toHaveTextContent(ru.errors.VALIDATION_FAILED.text);
    expect(screen.queryByRole('button', { name: ru.common.retry })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: copy.editData }));
    expect(onEdit).toHaveBeenCalledTimes(1);
  });

  it('has an empty state for a chart that came back with nothing to show', async () => {
    const empty: ChartResult = { chart: { ...chart, birth: {}, asc: {}, planets: [] } };
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
    setup({ result: { chart } });

    expect(await screen.findByText(copy.wheelMissing)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: copy.share })).not.toBeInTheDocument();
    expect(within(card(copy.sun)).getByText(/Телец, 26°17′/)).toBeInTheDocument();
    expect(within(card(copy.teaserTitle)).getByRole('button', { name: copy.teaserCta })).toBeDisabled();
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
