import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChartResult, Me, TimePrecision } from './api';
import { App } from './App';
import { SEARCH_DEBOUNCE_MS } from './hooks/usePlaceSearch';
import { CONSENT_VERSION, ru } from './i18n/ru';
import { apiError, chartRequest, chartResult, deferred, fakeApi, fakeTelegram, kazan, me, rejection, setupUser, TODAY } from './test/fixtures';

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
const consentBox = () => screen.getByRole('checkbox', { name: ru.consent.checkbox });
const proceed = () => screen.getByRole('button', { name: ru.consent.submit });
const buildChart = () => screen.getByRole('button', { name: ru.birthPlace.submit });
const settleSearch = () => act(() => vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS));

/** From the welcome screen to the consent screen. */
async function openConsent(user: FakeUser) {
  await user.click(await start());
}

async function giveConsent(user: FakeUser) {
  await openConsent(user);
  await user.click(consentBox());
  await user.click(proceed());
}

async function enterDate(user: FakeUser, digits = '17051994') {
  await giveConsent(user);
  await user.keyboard(digits);
  await user.click(next());
}

async function enterTime(user: FakeUser, mode: TimePrecision, digits = '') {
  await user.click(screen.getByRole('radio', { name: ru.birthTime.options[mode].title }));
  if (digits) await user.keyboard(digits);
  await user.click(next());
}

async function enterPlace(user: FakeUser) {
  await user.type(screen.getByLabelText(ru.birthPlace.label), 'Каз');
  await settleSearch();
  await user.click(screen.getByRole('button', { name: /Казань/ }));
  await user.click(buildChart());
}

/** Every step with the data of the `chartRequest` fixture, up to the request for the chart. */
async function fillIn(user: FakeUser) {
  await enterDate(user);
  await enterTime(user, 'exact', '1430');
  await enterPlace(user);
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

describe('App: consent to the processing of personal data', () => {
  it('asks for it right after the welcome screen, before any birth data, with the box empty', async () => {
    const { api, user } = setup();

    await openConsent(user);

    expect(heading()).toHaveTextContent(ru.consent.title);
    expect(heading()).toHaveFocus();
    expect(screen.getByText(ru.consent.lead)).toBeInTheDocument();
    for (const point of ru.consent.points) expect(screen.getByText(point)).toBeInTheDocument();
    expect(consentBox()).not.toBeChecked();
    expect(proceed()).toBeDisabled();
    expect(api.resolveGeo).not.toHaveBeenCalled();
    expect(api.createChart).not.toHaveBeenCalled();
  });

  it('lets the user on only while the box is ticked', async () => {
    const { user } = setup();
    await openConsent(user);

    await user.click(proceed());
    expect(heading()).toHaveTextContent(ru.consent.title);

    await user.click(consentBox());
    expect(consentBox()).toBeChecked();
    expect(proceed()).toBeEnabled();

    await user.click(consentBox());
    expect(consentBox()).not.toBeChecked();
    expect(proceed()).toBeDisabled();

    await user.click(consentBox());
    await user.click(proceed());
    expect(heading()).toHaveTextContent(ru.birthDate.title);
  });

  it('sends the consent and the version of its text with the chart request', async () => {
    const { api, user } = setup();

    await fillIn(user);

    await screen.findByRole('region', { name: ru.chart.sun });
    expect(api.createChart.mock.calls[0]?.[0].consent).toEqual({ accepted: true, version: CONSENT_VERSION });
  });

  it.each([
    ['privacy', ru.documents.privacy.notCollected],
    ['terms', ru.documents.terms.disclaimer],
  ] as const)('opens the %s document inside the app and comes back with the tick kept', async (name, text) => {
    const { telegram, user } = setup();
    await openConsent(user);
    await user.click(consentBox());

    await user.click(screen.getByRole('button', { name: ru.consent.documents[name] }));

    expect(heading()).toHaveTextContent(ru.consent.documents[name]);
    expect(heading()).toHaveFocus();
    expect(screen.getByText(text)).toBeInTheDocument();

    act(() => {
      backHandler(telegram)?.();
    });

    expect(heading()).toHaveTextContent(ru.consent.title);
    expect(consentBox()).toBeChecked();
  });

  it('opening a document does not tick the box', async () => {
    const { telegram, user } = setup();
    await openConsent(user);

    await user.click(screen.getByRole('button', { name: ru.consent.documents.privacy }));
    act(() => {
      backHandler(telegram)?.();
    });

    expect(consentBox()).not.toBeChecked();
    expect(proceed()).toBeDisabled();
  });

  it('remembers the answer while the user moves between the screens', async () => {
    const { telegram, user } = setup();
    await enterDate(user);

    act(() => {
      backHandler(telegram)?.();
    });
    act(() => {
      backHandler(telegram)?.();
    });

    expect(heading()).toHaveTextContent(ru.consent.title);
    expect(consentBox()).toBeChecked();
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
    expect(api.createChart.mock.calls[0]?.[0]).toEqual(chartRequest);
    expect(api.createChart.mock.calls[0]?.[0].birth_place).toBe(kazan);
    expect(screen.queryByText(ru.chart.approxTime)).not.toBeInTheDocument();
  });

  it('sends no time at all when the user does not know it', async () => {
    const { api, user } = setup();

    await enterDate(user, '29022000');
    await enterTime(user, 'unknown');
    await enterPlace(user);

    await screen.findByRole('region', { name: ru.chart.sun });
    expect(api.createChart.mock.calls[0]?.[0]).toEqual({
      ...chartRequest,
      birth_date: '2000-02-29',
      birth_time: null,
      time_precision: 'unknown',
    });
  });

  it('does not send a time typed before the user switched to "I don\'t know"', async () => {
    const { api, user } = setup();

    await enterDate(user);
    await user.click(screen.getByRole('radio', { name: ru.birthTime.options.exact.title }));
    await user.keyboard('0905');
    await enterTime(user, 'unknown');
    await enterPlace(user);

    await screen.findByRole('region', { name: ru.chart.sun });
    expect(api.createChart.mock.calls[0]?.[0]).toMatchObject({ birth_time: null, time_precision: 'unknown' });
  });

  it('sends a roughly known time as approximate, and the chart that echoes it carries the accuracy note', async () => {
    const approximate: ChartResult = {
      ...chartResult,
      chart: { ...chartResult.chart, birth: { ...chartResult.chart.birth, time: '09:05', time_precision: 'approximate' } },
    };
    const { api, user } = setup({ api: (fake) => fake.createChart.mockResolvedValue(approximate) });

    await enterDate(user);
    await enterTime(user, 'approximate', '0905');
    await enterPlace(user);

    expect(await screen.findByText(ru.chart.approxTime)).toBeInTheDocument();
    expect(api.createChart.mock.calls[0]?.[0]).toMatchObject({ birth_time: '09:05', time_precision: 'approximate' });
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

  it('returns to the birth date with everything still filled in when the server rejects the data without naming a field', async () => {
    const { user } = setup({ api: (fake) => fake.createChart.mockRejectedValue(apiError('VALIDATION_FAILED', { status: 422 })) });
    await fillIn(user);

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

describe('App: fields the server rejects', () => {
  const DATE = { field: 'birth_date', message: 'Сервис доступен с 18 лет' };
  const TIME = { field: 'birth_time', message: 'Укажи время рождения в формате ЧЧ:ММ или отметь, что не знаешь' };
  const PRECISION = { field: 'time_precision', message: 'Укажи, насколько точно известно время рождения' };
  const PLACE = { field: 'birth_place', message: 'Не знаем такой часовой пояс — выбери город заново' };
  const CONSENT = { field: 'consent', message: 'Без согласия на обработку данных мы не можем построить карту' };

  /** Fills everything in; the server rejects the first chart request with `fields` and accepts the next one. */
  async function rejectedOnce(...fields: { field: string; message: string }[]) {
    const view = setup({ api: (fake) => fake.createChart.mockRejectedValueOnce(rejection(...fields)) });
    await fillIn(view.user);
    await screen.findAllByRole('alert');
    return view;
  }

  it('brings the user to the date with the server text at the field and everything still filled in', async () => {
    await rejectedOnce(DATE);

    expect(heading()).toHaveTextContent(ru.birthDate.title);
    expect(screen.getByRole('alert')).toHaveTextContent(DATE.message);
    const day = screen.getByLabelText(ru.birthDate.day);
    expect(day).toHaveValue('17');
    expect(day).toHaveAttribute('aria-invalid', 'true');
    expect(day).toHaveFocus();
    expect(screen.getByLabelText(ru.birthDate.year)).toHaveValue('1994');
  });

  it('walks forward from there through the untouched answers and asks the server again', async () => {
    const { api, user } = await rejectedOnce(DATE);

    await user.click(next());
    expect(heading()).toHaveTextContent(ru.birthTime.title);
    expect(screen.getByRole('radio', { name: ru.birthTime.options.exact.title })).toBeChecked();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    await user.click(next());
    expect(heading()).toHaveTextContent(ru.birthPlace.title);
    expect(screen.getByText(ru.birthPlace.timezone('Europe/Moscow'))).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    await user.click(buildChart());

    expect(await screen.findByRole('region', { name: ru.chart.sun })).toBeInTheDocument();
    expect(api.createChart).toHaveBeenCalledTimes(2);
    expect(api.createChart.mock.calls[1]?.[0]).toEqual(chartRequest);
  });

  it('drops the server text as soon as the user changes the field it was about', async () => {
    const { user } = await rejectedOnce(DATE);

    await user.type(screen.getByLabelText(ru.birthDate.year), '{Backspace}3');

    expect(screen.getByLabelText(ru.birthDate.year)).toHaveValue('1993');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('leads Back from the rejected step the usual way: consent, then the welcome screen', async () => {
    const { telegram } = await rejectedOnce(DATE);

    act(() => {
      backHandler(telegram)?.();
    });
    expect(heading()).toHaveTextContent(ru.consent.title);
    expect(consentBox()).toBeChecked();

    act(() => {
      backHandler(telegram)?.();
    });
    expect(heading()).toHaveTextContent(ru.welcome.title);
    expect(backHandler(telegram)).toBeNull();
  });

  it('shows the text about the time at the time field', async () => {
    await rejectedOnce(TIME);

    expect(heading()).toHaveTextContent(ru.birthTime.title);
    expect(screen.getByRole('alert')).toHaveTextContent(TIME.message);
    expect(screen.getByLabelText(ru.birthTime.hours)).toHaveValue('14');
    expect(screen.getByLabelText(ru.birthTime.hours)).toHaveFocus();
  });

  it('drops the text about the time when the user edits the time', async () => {
    const { user } = await rejectedOnce(TIME);

    await user.type(screen.getByLabelText(ru.birthTime.minutes), '{Backspace}5');

    expect(screen.getByLabelText(ru.birthTime.minutes)).toHaveValue('35');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows the text about the precision at the options; another option answers both the precision and the time', async () => {
    const { user } = await rejectedOnce(PRECISION, TIME);

    expect(heading()).toHaveTextContent(ru.birthTime.title);
    expect(screen.getAllByRole('alert').map((alert) => alert.textContent)).toEqual([PRECISION.message, TIME.message]);
    expect(screen.getByRole('radio', { name: ru.birthTime.options.exact.title })).toHaveFocus();

    await user.click(screen.getByRole('radio', { name: ru.birthTime.options.unknown.title }));

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows the text about the place at the search field, with the place still on screen', async () => {
    const { user } = await rejectedOnce(PLACE);

    expect(heading()).toHaveTextContent(ru.birthPlace.title);
    expect(screen.getByRole('alert')).toHaveTextContent(PLACE.message);
    const field = screen.getByLabelText(ru.birthPlace.label);
    expect(field).toHaveValue('Казань');
    expect(field).toHaveFocus();
    expect(screen.getByText(ru.birthPlace.timezone('Europe/Moscow'))).toBeInTheDocument();

    await user.type(field, 'к');

    expect(screen.queryByText(PLACE.message)).not.toBeInTheDocument();
  });

  it('brings the user back to the consent screen when the consent is what the server rejected', async () => {
    const { telegram, user } = await rejectedOnce(CONSENT);

    expect(heading()).toHaveTextContent(ru.consent.title);
    expect(screen.getByRole('alert')).toHaveTextContent(CONSENT.message);
    expect(consentBox()).toHaveAttribute('aria-invalid', 'true');
    expect(consentBox()).toHaveAccessibleDescription(CONSENT.message);
    expect(consentBox()).toHaveFocus();

    // Answering again is the user acting on the text: it goes away.
    await user.click(consentBox());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(proceed()).toBeDisabled();

    act(() => {
      backHandler(telegram)?.();
    });
    expect(heading()).toHaveTextContent(ru.welcome.title);
  });

  it('starts at the earliest rejected step and shows the text of each later one when the user gets there', async () => {
    const { user } = await rejectedOnce(PLACE, DATE);

    expect(heading()).toHaveTextContent(ru.birthDate.title);
    expect(screen.getByRole('alert')).toHaveTextContent(DATE.message);

    await user.click(next());
    expect(heading()).toHaveTextContent(ru.birthTime.title);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    await user.click(next());
    expect(heading()).toHaveTextContent(ru.birthPlace.title);
    expect(screen.getByRole('alert')).toHaveTextContent(PLACE.message);
  });

  it('shows the first text when the server names a field twice', async () => {
    await rejectedOnce(PLACE, { field: 'birth_place', message: 'Код страны — две заглавные буквы (RU, KZ)' });

    expect(screen.getByRole('alert')).toHaveTextContent(PLACE.message);
    expect(screen.queryByText(/Код страны/)).not.toBeInTheDocument();
  });

  it('forgets the old verdict once a new request is sent', async () => {
    const { telegram, user } = await rejectedOnce(PLACE);

    await user.click(buildChart());
    await screen.findByRole('region', { name: ru.chart.sun });
    act(() => {
      backHandler(telegram)?.();
    });

    expect(heading()).toHaveTextContent(ru.birthPlace.title);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('stays on the chart screen with the server text when the field belongs to no screen', async () => {
    await rejectedOnce({ field: 'body', message: 'Проверь это поле' });

    expect(heading()).toHaveTextContent(ru.chart.title);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(ru.errors.VALIDATION_FAILED.title);
    expect(alert).toHaveTextContent('Проверь это поле');
    expect(screen.getByRole('button', { name: ru.chart.editData })).toBeInTheDocument();
  });

  it('does not move a user who has already left the chart screen when the rejection arrives', async () => {
    const pending = deferred<ChartResult>();
    const { telegram, user } = setup({ api: (fake) => fake.createChart.mockImplementation(() => pending.promise) });
    await fillIn(user);
    act(() => {
      backHandler(telegram)?.();
    });
    expect(heading()).toHaveTextContent(ru.birthPlace.title);

    await act(async () => {
      pending.reject(rejection(DATE));
      await pending.promise.catch(() => undefined);
    });

    expect(heading()).toHaveTextContent(ru.birthPlace.title);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
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
    // Nothing is left to type in a finished date, so the title is what gets announced.
    expect(heading()).toHaveFocus();

    act(() => {
      backHandler(telegram)?.();
    });
    expect(heading()).toHaveTextContent(ru.consent.title);

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

    await openConsent(user);
    expect(heading()).toHaveTextContent(ru.consent.title);
    await user.click(screen.getByRole('button', { name: ru.consent.documents.terms }));
    expect(heading()).toHaveTextContent(ru.consent.documents.terms);

    await user.click(screen.getByRole('button', { name: ru.common.back }));
    expect(heading()).toHaveTextContent(ru.consent.title);

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
