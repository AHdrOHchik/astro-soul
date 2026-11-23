import { act, render, screen } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Forecast } from '../../api';
import { ru } from '../../i18n/ru';
import { apiError, chart, deferred, fakeAnalytics, fakeApi, fakeTelegram, forecast, freeForecast, setupUser, TODAY } from '../../test/fixtures';
import { ForecastScreen, type ForecastScreenProps } from './ForecastScreen';

const copy = ru.forecast;
const CHART_ID = chart.chart_id;
const TEN_MINUTES = 10 * 60_000;

interface SetupOptions extends Partial<Pick<ForecastScreenProps, 'timeZone' | 'known' | 'onSubscribe'>> {
  /** What `GET /engagement/forecast` answers: a forecast, null for the contract's 404, or a failure. */
  answer?: Forecast | null | Error | Promise<Forecast | null>;
  now?: Date;
  /** A clock only the test moves. */
  manualClock?: boolean;
}

function setup({ answer = forecast, now = TODAY, manualClock = false, timeZone = 'Europe/Moscow', ...props }: SetupOptions = {}) {
  const api = fakeApi();
  api.getForecast.mockImplementation(() => (answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer)));
  const telegram = fakeTelegram({ canSwitchInlineQuery: true });
  const analytics = fakeAnalytics();
  const onAsk = vi.fn();
  const onClose = vi.fn();
  const onNotReady = vi.fn();
  const onKnown = vi.fn<NonNullable<ForecastScreenProps['onKnown']>>();
  const user = setupUser({ manual: manualClock });
  const view = render(
    <ForecastScreen
      api={api}
      telegram={telegram}
      chartId={CHART_ID}
      timeZone={timeZone}
      now={() => now}
      track={analytics.track}
      onKnown={onKnown}
      onAsk={onAsk}
      onClose={onClose}
      onNotReady={onNotReady}
      {...props}
    />,
  );
  return { api, telegram, analytics, onAsk, onClose, onNotReady, onKnown, user, ...view };
}

afterEach(() => {
  vi.useRealTimers();
});

/** Lets the timers run for `ms`, and with them everything that was waiting for an answer. */
const pass = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));
const title = () => screen.getByRole('heading', { level: 1 });

describe('ForecastScreen', () => {
  it('asks the server once as it opens and shows what it has: the day, the focus, the whole text', async () => {
    const pending = deferred<Forecast | null>();
    const { api, analytics } = setup({ answer: pending.promise });

    expect(screen.getByRole('main')).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('status')).toHaveTextContent(copy.loading);
    expect(analytics.names()).toEqual([]);

    await act(async () => {
      pending.resolve(forecast);
      await pending.promise;
    });

    expect(title()).toHaveTextContent('Прогноз на сегодня');
    expect(screen.getByText('10 ноября')).toBeInTheDocument();
    expect(screen.getByText('Фокус дня: карьера')).toBeInTheDocument();
    // All of the text the server gave out, as it came.
    expect(screen.getByText(forecast.text)).toBeInTheDocument();
    expect(screen.getByRole('main')).not.toHaveAttribute('aria-busy', 'true');

    expect(api.getForecast).toHaveBeenCalledTimes(1);
    expect(api.getForecast.mock.calls[0]?.[0]).toBe(CHART_ID);
    expect(analytics.events).toEqual([{ name: 'forecast_view' }]);
  });

  it.each([
    ['a forecast', forecast],
    ['no forecast yet', null],
    ['a failure', apiError('NETWORK')],
  ])('never asks again by itself: after %s, ten minutes on the screen are still one request', async (_name, answer) => {
    const { api } = setup({ answer, manualClock: true });
    await pass(0);
    expect(api.getForecast).toHaveBeenCalledTimes(1);

    await pass(TEN_MINUTES);
    expect(api.getForecast).toHaveBeenCalledTimes(1);
  });

  describe('no forecast yet (the contract\'s 404)', () => {
    it('says so in the owner\'s words, as a state of the day: no alert, nothing to repeat, the way back to the chart', async () => {
      const { api, analytics, onClose, onNotReady, user } = setup({ answer: null });

      expect(await screen.findByRole('heading', { name: 'Сегодняшний прогноз готовится' })).toBeInTheDocument();
      expect(screen.getByText('Загляни после 08:00')).toBeInTheDocument();
      // Not a failure: nothing is announced as one, and there is no button that would ask again.
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: ru.common.retry })).not.toBeInTheDocument();
      expect(screen.getAllByRole('button').map((button) => button.textContent)).toEqual(['К карте']);

      await user.click(screen.getByRole('button', { name: 'К карте' }));
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(api.getForecast).toHaveBeenCalledTimes(1);
      // Nothing was seen and nothing failed.
      expect(analytics.names()).toEqual([]);
      // The caller hears of it once, to check on its own that the chart is still there.
      expect(onNotReady).toHaveBeenCalledTimes(1);
    });

    it('offers no subscription and no question there: the screen has only said that there is nothing yet', async () => {
      const onSubscribe = vi.fn();
      setup({ answer: null, onSubscribe });
      await screen.findByRole('heading', { name: copy.pendingTitle });
      expect(screen.queryByText(copy.subscriptionOnly)).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: copy.ask })).not.toBeInTheDocument();
    });
  });

  describe('a failed request', () => {
    it('is named as that, and is repeated by the user\'s tap alone', async () => {
      const { api, analytics, onNotReady, user } = setup({ answer: apiError('NETWORK') });

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent('Не получилось загрузить прогноз');
      expect(alert).toHaveTextContent(ru.errors.NETWORK.text);
      // A failure is not «not prepared yet», and is not shown as it.
      expect(screen.queryByText(copy.pendingTitle)).not.toBeInTheDocument();
      expect(onNotReady).not.toHaveBeenCalled();
      expect(analytics.events).toEqual([{ name: 'error_shown', props: { screen: 'forecast', code: 'NETWORK' } }]);

      api.getForecast.mockResolvedValueOnce(forecast);
      await user.click(screen.getByRole('button', { name: ru.common.retry }));
      expect(await screen.findByText(forecast.text)).toBeInTheDocument();
      expect(api.getForecast).toHaveBeenCalledTimes(2);
    });

    it('shows the server\'s own words and its request id, and leads back to the chart', async () => {
      const failure = apiError('INTERNAL', { status: 500, serverMessage: 'Что-то сломалось на нашей стороне. Мы уже разбираемся.', requestId: 'req-500' });
      const { analytics, onClose, user } = setup({ answer: failure });

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent('Что-то сломалось на нашей стороне. Мы уже разбираемся.');
      expect(screen.getByText(ru.common.requestId('req-500'))).toBeInTheDocument();
      // The event names the failure by its status, never by the server's text.
      expect(analytics.events).toEqual([{ name: 'error_shown', props: { screen: 'forecast', code: '500' } }]);

      await user.click(screen.getByRole('button', { name: 'К карте' }));
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });

  describe('the short forecast (is_paid: false)', () => {
    it('shows the text first and the note about the subscription under it, leading to the paywall', async () => {
      const onSubscribe = vi.fn();
      const { user } = setup({ answer: freeForecast, onSubscribe });

      const text = await screen.findByText(freeForecast.text);
      const note = screen.getByRole('button', { name: 'Полный прогноз — в подписке' });
      // Under the text: the note follows it in the document, and nothing stands in place of the text.
      expect(text.compareDocumentPosition(note) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      // No focus came with the short text, so no label is made up for it.
      expect(screen.queryByText(/Фокус дня/)).not.toBeInTheDocument();

      await user.click(note);
      expect(onSubscribe).toHaveBeenCalledTimes(1);
    });

    it('says nothing of a subscription where there is none to offer: to a subscriber, or in a build that sells none', async () => {
      setup({ answer: freeForecast });
      expect(await screen.findByText(freeForecast.text)).toBeInTheDocument();
      expect(screen.queryByText(copy.subscriptionOnly)).not.toBeInTheDocument();
      expect(screen.queryByText(/подписк/i)).not.toBeInTheDocument();
    });
  });

  it('has no note about a subscription under the full forecast', async () => {
    setup({ answer: forecast, onSubscribe: vi.fn() });
    expect(await screen.findByText(forecast.text)).toBeInTheDocument();
    expect(screen.queryByText(copy.subscriptionOnly)).not.toBeInTheDocument();
  });

  it('shows no focus when the server named none', async () => {
    setup({ answer: { ...forecast, focus: null } });
    expect(await screen.findByText(forecast.text)).toBeInTheDocument();
    expect(screen.queryByText(/Фокус дня/)).not.toBeInTheDocument();
  });

  it.each([
    ['career', 'Фокус дня: карьера'],
    ['love', 'Фокус дня: отношения'],
    ['money', 'Фокус дня: деньги'],
    ['wellbeing', 'Фокус дня: самочувствие'],
    ['self', 'Фокус дня: внимание к себе'],
  ] as const)('names the focus %s in words: «%s»', async (focus, label) => {
    setup({ answer: { ...forecast, focus } });
    expect(await screen.findByText(label)).toBeInTheDocument();
    // Never the code itself.
    expect(screen.queryByText(new RegExp(`\\b${focus}\\b`))).not.toBeInTheDocument();
  });

  describe('which day the forecast is for', () => {
    // 22:30 UTC on 10 November: the 11th in Kazan, where the chart was born; the 10th in Amsterdam and in UTC.
    const evening = new Date('2026-11-10T22:30:00Z');

    it('is «today» by the calendar of the birth place, not of the device', async () => {
      setup({ answer: { ...forecast, date: '2026-11-11' }, now: evening, timeZone: 'Europe/Moscow' });
      await screen.findByText(forecast.text);
      expect(title()).toHaveTextContent('Прогноз на сегодня');
      expect(screen.getByText('11 ноября')).toBeInTheDocument();
    });

    it.each([
      ['yesterday\'s, kept past midnight at the birth place', '2026-11-10', 'Europe/Moscow', 'Прогноз на 10 ноября'],
      ['of a day that has not come there yet', '2026-11-11', 'Europe/Amsterdam', 'Прогноз на 11 ноября'],
      ['of a chart that names no zone to count the day in', '2026-11-10', null, 'Прогноз на 10 ноября'],
    ])('never calls a forecast %s «today\'s»: it is named by its date', async (_name, date, timeZone, expected) => {
      setup({ answer: { ...forecast, date }, now: evening, timeZone });
      await screen.findByText(forecast.text);
      expect(title()).toHaveTextContent(expected);
      expect(screen.queryByText(/сегодня/i)).not.toBeInTheDocument();
    });
  });

  describe('sharing', () => {
    it('sends the picture of the chart with its words, and not a word of the forecast', async () => {
      const { api, telegram, analytics, user } = setup();
      await screen.findByText(forecast.text);
      analytics.clear();
      expect(api.createShareCard).not.toHaveBeenCalled();
      expect(analytics.events.filter(({ name }) => name === 'share_sent')).toEqual([]);

      await user.click(screen.getByRole('button', { name: ru.shareCard.day }));
      await user.click(screen.getByRole('button', { name: ru.shareCard.inline }));
      expect(api.createShareCard).toHaveBeenCalledWith('day', expect.any(String));
      expect(telegram.switchInlineQuery).toHaveBeenCalledWith('Мне тут сделали разбор личности — залипательно');
      expect(analytics.events).toEqual([
        { name: 'share_clicked' },
        { name: 'share_sent', props: { kind: 'day', channel: 'inline' } },
      ]);
    });

    it('has no share button without a picture to send', async () => {
      setup();
      await screen.findByText(forecast.text);
      expect(screen.getByRole('button', { name: ru.shareCard.day })).toBeInTheDocument();
    });
  });

  it('«Спросить карту» leads to the question screen', async () => {
    const { onAsk, user } = setup();
    await user.click(await screen.findByRole('button', { name: 'Спросить карту' }));
    expect(onAsk).toHaveBeenCalledTimes(1);
  });

  describe('what the app heard before', () => {
    it('is on screen from the first frame while the server is asked again, and gives way to the fresh answer', async () => {
      const pending = deferred<Forecast | null>();
      const heard = { ...forecast, text: 'Текст, который приложение уже видело.' };
      const { api, analytics, onKnown } = setup({ answer: pending.promise, known: { chartId: CHART_ID, forecast: heard } });

      expect(screen.getByText(heard.text)).toBeInTheDocument();
      expect(screen.queryByText(copy.loading)).not.toBeInTheDocument();
      expect(api.getForecast).toHaveBeenCalledTimes(1);

      await act(async () => {
        pending.resolve(forecast);
        await pending.promise;
      });
      expect(screen.getByText(forecast.text)).toBeInTheDocument();
      expect(screen.queryByText(heard.text)).not.toBeInTheDocument();
      expect(onKnown).toHaveBeenCalledWith(CHART_ID, forecast);
      // One opening, one view: the fresh answer is not a second one.
      expect(analytics.names()).toEqual(['forecast_view']);
    });

    it('is not shown for another chart', () => {
      const pending = deferred<Forecast | null>();
      const heard = { ...forecast, text: 'Прогноз другой карты.' };
      setup({ answer: pending.promise, known: { chartId: 'another-chart', forecast: heard } });
      expect(screen.queryByText(heard.text)).not.toBeInTheDocument();
      expect(screen.getByRole('status')).toHaveTextContent(copy.loading);
    });

    it('stays when the server could not be asked again: the user keeps the text, and nothing is announced as a failure', async () => {
      const heard = { ...forecast, text: 'Текст, который приложение уже видело.' };
      const { api, analytics, onKnown } = setup({ answer: apiError('NETWORK'), known: { chartId: CHART_ID, forecast: heard } });
      await act(async () => {});

      expect(api.getForecast).toHaveBeenCalledTimes(1);
      expect(screen.getByText(heard.text)).toBeInTheDocument();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(screen.queryByText(copy.failedTitle)).not.toBeInTheDocument();
      // Nothing new was heard, and no failure was shown.
      expect(onKnown).not.toHaveBeenCalled();
      expect(analytics.names()).toEqual(['forecast_view']);
    });

    it('gives way to «not prepared yet» as well: the server\'s fresh word is the one on screen', async () => {
      const heard = { ...forecast, date: '2026-11-09', text: 'Вчерашний прогноз.' };
      const { onKnown } = setup({ answer: null, known: { chartId: CHART_ID, forecast: heard } });
      expect(await screen.findByRole('heading', { name: copy.pendingTitle })).toBeInTheDocument();
      expect(screen.queryByText(heard.text)).not.toBeInTheDocument();
      expect(onKnown).toHaveBeenCalledWith(CHART_ID, null);
    });
  });

  it('reports no word of the forecast: the events name the screen and the failure, nothing else', async () => {
    const { analytics, user } = setup();
    await screen.findByText(forecast.text);
    await user.click(screen.getByRole('button', { name: ru.shareCard.day }));
    await user.click(screen.getByRole('button', { name: ru.shareCard.inline }));
    await user.click(screen.getByRole('button', { name: copy.ask }));

    expect(analytics.events).toEqual([
      { name: 'forecast_view' },
      { name: 'share_clicked' },
      { name: 'share_sent', props: { kind: 'day', channel: 'inline' } },
    ]);
    expect(JSON.stringify(analytics.events)).not.toMatch(/[А-Яа-яЁё]/);
  });

  it('counts one view in a development build, which runs every effect twice: with the forecast on screen from the first frame', async () => {
    const api = fakeApi();
    api.getForecast.mockResolvedValue(forecast);
    const analytics = fakeAnalytics();
    render(
      <StrictMode>
        <ForecastScreen
          api={api}
          telegram={fakeTelegram()}
          chartId={CHART_ID}
          timeZone="Europe/Moscow"
          // The way the app opens the screen: the card on the chart has heard the forecast already.
          known={{ chartId: CHART_ID, forecast }}
          now={() => TODAY}
          track={analytics.track}
          onAsk={vi.fn()}
          onClose={vi.fn()}
        />
      </StrictMode>,
    );
    expect(screen.getByText(forecast.text)).toBeInTheDocument();
    await act(async () => {});
    expect(analytics.names()).toEqual(['forecast_view']);
  });

  it('tells the caller of «none yet» once in a development build as well', async () => {
    const api = fakeApi();
    api.getForecast.mockResolvedValue(null);
    const onNotReady = vi.fn();
    render(
      <StrictMode>
        <ForecastScreen
          api={api}
          telegram={fakeTelegram()}
          chartId={CHART_ID}
          timeZone="Europe/Moscow"
          now={() => TODAY}
          track={vi.fn()}
          onAsk={vi.fn()}
          onClose={vi.fn()}
          onNotReady={onNotReady}
        />
      </StrictMode>,
    );
    expect(await screen.findByRole('heading', { name: copy.pendingTitle })).toBeInTheDocument();
    expect(onNotReady).toHaveBeenCalledTimes(1);
  });

  it('drops the request when the screen is left before the answer', () => {
    const pending = deferred<Forecast | null>();
    const { api, unmount } = setup({ answer: pending.promise });
    const signal = api.getForecast.mock.calls[0]?.[1];
    expect(signal?.aborted).toBe(false);
    unmount();
    expect(signal?.aborted).toBe(true);
  });
});

describe('ForecastScreen: «готовится», the first day of a chart and every morning before the forecast is written', () => {
  it('says whose 08:00 it is, as a second line in small print under «Загляни после 08:00»', async () => {
    setup({ answer: null });
    await screen.findByRole('heading', { name: 'Сегодняшний прогноз готовится' });

    const lines = [...screen.getByRole('status').querySelectorAll('h2, p')].map((line) => line.textContent);
    expect(lines).toEqual(['Сегодняшний прогноз готовится', 'Загляни после 08:00', 'Время считается по месту рождения.']);
    // With the test setup of CSS modules a class is its own name in the stylesheet (StateView.module.css).
    expect(screen.getByText('Время считается по месту рождения.')).toHaveClass('note');
    expect(screen.getByText('Загляни после 08:00')).not.toHaveClass('note');
  });

  it('says it whether or not the app knows the zone of the birth place: the server counts by it either way', async () => {
    setup({ answer: null, timeZone: null });
    expect(await screen.findByText('Время считается по месту рождения.')).toBeInTheDocument();
  });

  it('promises no question for that day: no way to the question screen, and not a word about asking', async () => {
    const { onAsk } = setup({ answer: null });
    await screen.findByRole('heading', { name: 'Сегодняшний прогноз готовится' });

    expect(screen.queryByRole('button', { name: 'Спросить карту' })).not.toBeInTheDocument();
    expect(screen.getByRole('main').textContent).not.toMatch(/вопрос|спроси/i);
    expect(onAsk).not.toHaveBeenCalled();
  });

  it('a forecast that is there has no such line: it is about the hour of one that is not', async () => {
    setup();
    await screen.findByText(forecast.text);
    expect(screen.queryByText('Время считается по месту рождения.')).not.toBeInTheDocument();
  });
});
