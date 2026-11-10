import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Me } from './api';
import { App } from './App';
import { SEARCH_DEBOUNCE_MS } from './hooks/usePlaceSearch';
import { ru } from './i18n/ru';
import { apiError, deferred, fakeApi, fakeTelegram, kazan, me, setupUser, TODAY } from './test/fixtures';

type FakeUser = ReturnType<typeof setupUser>;

function setup(options: { telegram?: Parameters<typeof fakeTelegram>[0]; api?: (api: ReturnType<typeof fakeApi>) => void } = {}) {
  const api = fakeApi();
  options.api?.(api);
  const telegram = fakeTelegram(options.telegram);
  const user = setupUser();
  const view = render(<App api={api} telegram={telegram} apiBaseUrl="https://api.test" today={TODAY} />);
  return { api, telegram, user, ...view };
}

const start = () => screen.findByRole('button', { name: ru.welcome.start });
const next = () => screen.getByRole('button', { name: ru.common.next });
const heading = () => screen.getByRole('heading', { level: 1 });
const settleSearch = () => act(() => vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS));

async function enterDate(user: FakeUser, digits = '17051994') {
  await user.click(await start());
  await user.keyboard(digits);
  await user.click(next());
}

async function enterTime(user: FakeUser, mode: 'exact' | 'approx' | 'unknown', digits = '') {
  await user.click(screen.getByRole('radio', { name: ru.birthTime.options[mode].title }));
  if (digits) await user.keyboard(digits);
  await user.click(next());
}

async function enterPlace(user: FakeUser) {
  await user.type(screen.getByLabelText(ru.birthPlace.label), 'Каз');
  await settleSearch();
  await user.click(screen.getByRole('button', { name: /Казань/ }));
  await user.click(screen.getByRole('button', { name: ru.birthPlace.submit }));
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
    expect(screen.queryByText(ru.welcome.returning)).not.toBeInTheDocument();
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

  it('tells a returning user that the data has to be entered again', async () => {
    setup({ api: (fake) => fake.getMe.mockResolvedValue({ ...me, is_new: false, has_profile: true, has_chart: true }) });
    await start();
    expect(screen.getByRole('note')).toHaveTextContent(ru.welcome.returning);
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
    expect(api.createChart.mock.calls[0]?.[0]).toEqual({ birth_date: '1994-05-17', birth_time: '14:30', birth_place: kazan });
    expect(api.createChart.mock.calls[0]?.[0].birth_place).toBe(kazan);
    expect(screen.queryByText(ru.chart.approxTime)).not.toBeInTheDocument();
  });

  it('sends no time at all when the user does not know it', async () => {
    const { api, user } = setup();

    await enterDate(user, '29022000');
    await enterTime(user, 'unknown');
    await enterPlace(user);

    await screen.findByRole('region', { name: ru.chart.sun });
    expect(api.createChart.mock.calls[0]?.[0]).toEqual({ birth_date: '2000-02-29', birth_time: null, birth_place: kazan });
  });

  it('does not send a time typed before the user switched to "I don\'t know"', async () => {
    const { api, user } = setup();

    await enterDate(user);
    await user.click(screen.getByRole('radio', { name: ru.birthTime.options.exact.title }));
    await user.keyboard('0905');
    await enterTime(user, 'unknown');
    await enterPlace(user);

    await screen.findByRole('region', { name: ru.chart.sun });
    expect(api.createChart.mock.calls[0]?.[0].birth_time).toBeNull();
  });

  it('carries the "roughly" choice to the chart as an accuracy note', async () => {
    const { api, user } = setup();

    await enterDate(user);
    await enterTime(user, 'approx', '0905');
    await enterPlace(user);

    expect(await screen.findByText(ru.chart.approxTime)).toBeInTheDocument();
    expect(api.createChart.mock.calls[0]?.[0].birth_time).toBe('09:05');
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

  it('returns to the birth date with everything still filled in when the server rejects the data', async () => {
    const { user } = setup({ api: (fake) => fake.createChart.mockRejectedValue(apiError('VALIDATION_FAILED', { status: 422 })) });
    await enterDate(user);
    await enterTime(user, 'exact', '1430');
    await enterPlace(user);

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

    await user.click(await start());
    expect(heading()).toHaveTextContent(ru.birthDate.title);

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
