import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Forecast } from '../../api';
import { ru } from '../../i18n/ru';
import { apiError, chart, deferred, fakeApi, forecast, setupUser, TODAY } from '../../test/fixtures';
import { ForecastCard, type ForecastCardProps } from './ForecastCard';

const copy = ru.forecast;
const CHART_ID = chart.chart_id;

interface SetupOptions extends Partial<Pick<ForecastCardProps, 'timeZone' | 'known'>> {
  answer?: Forecast | null | Error | Promise<Forecast | null>;
  now?: Date;
  manualClock?: boolean;
}

function setup({ answer = forecast, now = TODAY, manualClock = false, timeZone = 'Europe/Moscow', known }: SetupOptions = {}) {
  const api = fakeApi();
  api.getForecast.mockImplementation(() => (answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer)));
  const onOpen = vi.fn();
  const onKnown = vi.fn<NonNullable<ForecastCardProps['onKnown']>>();
  const user = setupUser({ manual: manualClock });
  const view = render(
    <ForecastCard api={api} chartId={CHART_ID} timeZone={timeZone} known={known} onKnown={onKnown} now={() => now} onOpen={onOpen} />,
  );
  return { api, onOpen, onKnown, user, ...view };
}

afterEach(() => {
  vi.useRealTimers();
});

const card = () => screen.getByRole('button');

describe('ForecastCard', () => {
  it('shows the name of the forecast and its first sentence, and no more of the text', async () => {
    const { api, onKnown } = setup();

    expect(await screen.findByText('Первое предложение прогноза.')).toBeInTheDocument();
    expect(card()).toHaveTextContent('Прогноз на сегодня');
    expect(card()).not.toHaveTextContent('Второе предложение');
    expect(card()).not.toHaveAttribute('aria-busy');
    expect(api.getForecast).toHaveBeenCalledTimes(1);
    expect(api.getForecast.mock.calls[0]?.[0]).toBe(CHART_ID);
    // The app keeps what the server said: the forecast screen opens with it at once.
    expect(onKnown).toHaveBeenCalledWith(CHART_ID, forecast);
  });

  it('is one button, and the tap on it leads to the forecast screen', async () => {
    const { onOpen, user } = setup();
    await screen.findByText('Первое предложение прогноза.');
    expect(screen.getAllByRole('button')).toHaveLength(1);
    await user.click(card());
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('while the answer is on its way: the name, a placeholder for the line, and the door already open', async () => {
    const pending = deferred<Forecast | null>();
    const { onOpen, user } = setup({ answer: pending.promise });

    expect(card()).toHaveAttribute('aria-busy', 'true');
    expect(card()).toHaveTextContent('Прогноз на сегодня');
    expect(card()).toHaveTextContent(copy.loading);
    await user.click(card());
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('no forecast yet: says so in a line, in the owner\'s words, and still leads to the screen', async () => {
    const { onOpen, onKnown, user } = setup({ answer: null });

    expect(await screen.findByText('Сегодняшний прогноз готовится. Загляни после 08:00')).toBeInTheDocument();
    expect(card()).toHaveTextContent('Прогноз на сегодня');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(onKnown).toHaveBeenCalledWith(CHART_ID, null);
    await user.click(card());
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('a failed request: says so in a line, and leaves the repeat to the forecast screen', async () => {
    const { api, onOpen, onKnown, user } = setup({ answer: apiError('NETWORK') });

    expect(await screen.findByText('Не получилось загрузить прогноз')).toBeInTheDocument();
    // A failure is not «not prepared yet».
    expect(screen.queryByText(/готовится/)).not.toBeInTheDocument();
    expect(onKnown).not.toHaveBeenCalled();
    await user.click(card());
    expect(onOpen).toHaveBeenCalledTimes(1);
    // The tap opens the screen; the card itself asks nothing again.
    expect(api.getForecast).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a forecast', forecast],
    ['no forecast yet', null],
    ['a failure', apiError('NETWORK')],
  ])('never asks again by itself: after %s, ten minutes on the chart screen are still one request', async (_name, answer) => {
    const { api } = setup({ answer, manualClock: true });
    await act(() => vi.advanceTimersByTimeAsync(0));
    await act(() => vi.advanceTimersByTimeAsync(10 * 60_000));
    expect(api.getForecast).toHaveBeenCalledTimes(1);
  });

  it('names a forecast of another day by its date, never «today\'s»', async () => {
    // 22:30 UTC on 10 November is the 11th in Kazan: the forecast of the 10th is yesterday's there.
    setup({ now: new Date('2026-11-10T22:30:00Z') });
    expect(await screen.findByText('Первое предложение прогноза.')).toBeInTheDocument();
    expect(card()).toHaveTextContent('Прогноз на 10 ноября');
    expect(card()).not.toHaveTextContent(/сегодня/i);
  });

  it('shows what the app heard before while the server is asked again', () => {
    const pending = deferred<Forecast | null>();
    setup({ answer: pending.promise, known: { chartId: CHART_ID, forecast: { ...forecast, text: 'Уже известный прогноз. Его продолжение.' } } });
    expect(card()).toHaveTextContent('Уже известный прогноз.');
    expect(card()).not.toHaveTextContent('Его продолжение');
    expect(card()).not.toHaveAttribute('aria-busy');
  });
});
