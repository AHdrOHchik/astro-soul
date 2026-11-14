import { act, render, screen, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAnalytics } from './analytics';
import type { ChartResult, Me, TimePrecision } from './api';
import { App } from './App';
import { SEARCH_DEBOUNCE_MS } from './hooks/usePlaceSearch';
import { CONSENT_VERSION, ru } from './i18n/ru';
import {
  apiError,
  chartRequest,
  chartResult,
  deferred,
  fakeAnalytics,
  fakeApi,
  fakeTelegram,
  fakeTermsReload,
  kazan,
  me,
  rejection,
  setupUser,
  TODAY,
} from './test/fixtures';

type FakeUser = ReturnType<typeof setupUser>;

interface SetupOptions {
  telegram?: Parameters<typeof fakeTelegram>[0];
  api?: (api: ReturnType<typeof fakeApi>) => void;
  /** What the start before this one left behind, and whether this browser keeps anything at all. */
  termsReload?: Parameters<typeof fakeTermsReload>[0];
  /** Renders as a development build does: every effect runs twice. */
  strict?: boolean;
}

function setup(options: SetupOptions = {}) {
  const api = fakeApi();
  options.api?.(api);
  const telegram = fakeTelegram(options.telegram);
  const analytics = fakeAnalytics();
  const termsReload = fakeTermsReload(options.termsReload);
  const user = setupUser();
  const app = (
    <App
      api={api}
      telegram={telegram}
      apiBaseUrl="https://api.test"
      track={analytics.track}
      termsReload={termsReload}
      today={TODAY}
    />
  );
  const view = render(options.strict ? <StrictMode>{app}</StrictMode> : app);
  return { api, telegram, analytics, termsReload, user, ...view };
}

const start = () => screen.findByRole('button', { name: ru.welcome.start });
const next = () => screen.getByRole('button', { name: ru.common.next });
const heading = () => screen.getByRole('heading', { level: 1 });
const consentBox = () => screen.getByRole('checkbox', { name: ru.consent.checkbox });
const proceed = () => screen.getByRole('button', { name: ru.consent.submit });
const notNow = () => screen.getByRole('button', { name: ru.consent.decline });
/** The small print under «Начать», the way to the agreement. */
const termsLine = () =>
  screen.getByRole('button', { name: `${ru.welcome.terms.before}${ru.welcome.terms.link}${ru.welcome.terms.after}` });
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
    expect(termsLine()).toBeInTheDocument();
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

});

describe('App: a user who already has a chart', () => {
  const returning: Me = { ...me, is_new: false, has_profile: true, has_chart: true, chart_id: chartResult.chart.chart_id };
  const restored: ChartResult = { ...chartResult, is_restored: true };

  it('opens on the chart from the server; the form is one tap away, and «Не сейчас» leads back to the chart', async () => {
    const { api, analytics, telegram, user } = setup({
      api: (fake) => {
        fake.getMe.mockResolvedValue(returning);
        fake.getCurrentChart.mockResolvedValue(restored);
      },
    });

    expect(await screen.findByRole('region', { name: ru.chart.sun })).toBeInTheDocument();
    expect(heading()).toHaveTextContent(ru.chart.title);
    expect(api.createChart).not.toHaveBeenCalled();
    expect(analytics.events).toEqual([
      { name: 'app_open' },
      { name: 'screen_view', props: { step: 'chart' } },
      { name: 'chart_restored' },
    ]);
    // The first screen of this start: nothing to go back to.
    expect(telegram.setBackHandler).toHaveBeenLastCalledWith(null);

    await user.click(screen.getByRole('button', { name: ru.chart.enterAgain }));
    // The consent is asked anew: the one given for the old chart was not given in this session.
    expect(heading()).toHaveTextContent(ru.consent.title);
    expect(consentBox()).not.toBeChecked();

    await user.click(notNow());
    expect(await screen.findByRole('region', { name: ru.chart.sun })).toBeInTheDocument();
    expect(api.getCurrentChart).toHaveBeenCalledTimes(2);
  });

  it('starts the onboarding when the server has no chart after all', async () => {
    const { api } = setup({ api: (fake) => fake.getMe.mockResolvedValue(returning) });

    expect(await start()).toBeInTheDocument();
    expect(heading()).toHaveTextContent(ru.welcome.title);
    expect(api.getCurrentChart).toHaveBeenCalledTimes(1);
  });

  it('does not ask a new user\'s server for a chart it cannot have', async () => {
    const { api } = setup();

    await start();
    expect(api.getCurrentChart).not.toHaveBeenCalled();
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

  it.each(['privacy', 'terms'] as const)('opens the %s document inside the app and comes back with the tick kept', async (name) => {
    const { telegram, user } = setup();
    await openConsent(user);
    await user.click(consentBox());

    await user.click(screen.getByRole('button', { name: ru.consent.documents[name] }));

    expect(heading()).toHaveTextContent(ru.consent.documents[name]);
    expect(heading()).toHaveFocus();
    for (const paragraph of ru.documents[name].paragraphs) expect(screen.getByText(paragraph)).toBeInTheDocument();
    expect(screen.getByText(ru.documents.version(CONSENT_VERSION))).toBeInTheDocument();

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

  it('opens the agreement straight from the welcome screen and comes back to it; reading is not consenting', async () => {
    const { api, telegram, user } = setup();
    await start();

    await user.click(termsLine());

    expect(heading()).toHaveTextContent(ru.consent.documents.terms);
    expect(heading()).toHaveFocus();
    for (const paragraph of ru.documents.terms.paragraphs) expect(screen.getByText(paragraph)).toBeInTheDocument();

    act(() => {
      backHandler(telegram)?.();
    });

    expect(heading()).toHaveTextContent(ru.welcome.title);
    expect(backHandler(telegram)).toBeNull();
    await openConsent(user);
    expect(consentBox()).not.toBeChecked();
    expect(api.createChart).not.toHaveBeenCalled();
  });

  describe('«Не сейчас»', () => {
    it('leads back to the welcome screen without a tick: asked again, the box is empty', async () => {
      const { api, telegram, user } = setup();
      await openConsent(user);
      await user.click(consentBox());
      expect(consentBox()).toBeChecked();

      await user.click(notNow());

      expect(heading()).toHaveTextContent(ru.welcome.title);
      expect(heading()).toHaveFocus();
      // The first screen again: nothing to go back to.
      expect(backHandler(telegram)).toBeNull();

      await openConsent(user);
      expect(consentBox()).not.toBeChecked();
      expect(proceed()).toBeDisabled();
      expect(api.resolveGeo).not.toHaveBeenCalled();
      expect(api.createChart).not.toHaveBeenCalled();
    });
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
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
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

  it('sends a roughly known time as approximate, and shows the server\'s warning about it on the chart', async () => {
    const approximate: ChartResult = {
      ...chartResult,
      chart: { ...chartResult.chart, birth: { ...chartResult.chart.birth, time: '09:05', time_precision: 'approximate' } },
      warnings: ['approximate_time'],
    };
    const { api, user } = setup({ api: (fake) => fake.createChart.mockResolvedValue(approximate) });

    await enterDate(user);
    await enterTime(user, 'approximate', '0905');
    await enterPlace(user);

    expect(await screen.findByText(ru.chart.warnings.approximate_time)).toBeInTheDocument();
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

describe('App: the server refuses the version of the consent', () => {
  const VERSION = { field: 'consent.version', message: 'Условия обновились — подтверди согласие ещё раз' };
  const DATE = { field: 'birth_date', message: 'Сервис доступен с 18 лет' };
  /** What the task asks the user to see after the restart, letter for letter. */
  const RENEWED = 'Условия обновились, подтверди ещё раз.';
  /** A version older than the one of this build: the build before the restart had it. */
  const OLDER_VERSION = '2026-01-01';

  /** Fills everything in; the server refuses the chart request because of `fields`. */
  async function refused(options: SetupOptions = {}, ...fields: { field: string; message: string }[]) {
    const view = setup({ ...options, api: (fake) => fake.createChart.mockRejectedValue(rejection(...fields)) });
    await fillIn(view.user);
    return view;
  }

  describe('in the build that was refused', () => {
    it('notes the refused version, then restarts the app: newer texts come only with a newer build', async () => {
      const { termsReload } = await refused({}, VERSION);

      await waitFor(() => {
        expect(termsReload.reload).toHaveBeenCalledTimes(1);
      });
      expect(termsReload.remember).toHaveBeenCalledTimes(1);
      expect(termsReload.remember).toHaveBeenCalledWith(CONSENT_VERSION);
      expect(termsReload.remember.mock.invocationCallOrder[0]).toBeLessThan(termsReload.reload.mock.invocationCallOrder[0] ?? 0);
    });

    it('restarts even when the server names other fields too: nothing can be corrected under outdated texts', async () => {
      const { termsReload } = await refused({}, DATE, VERSION);

      await waitFor(() => {
        expect(termsReload.reload).toHaveBeenCalledTimes(1);
      });
      expect(screen.queryByText(DATE.message)).not.toBeInTheDocument();
      expect(screen.queryByText(ru.birthDate.title)).not.toBeInTheDocument();
    });

    describe('where the browser keeps nothing between page loads', () => {
      it('says what happened instead of restarting without a word, and leaves the restart to the user', async () => {
        const { termsReload, user } = await refused({ termsReload: { storage: false } }, VERSION);

        const alert = await screen.findByRole('alert');
        expect(alert).toHaveTextContent(ru.termsUpdate.outdatedTitle);
        expect(alert).toHaveTextContent(ru.termsUpdate.outdatedText);
        expect(termsReload.reload).not.toHaveBeenCalled();

        await user.click(screen.getByRole('button', { name: ru.termsUpdate.reload }));

        expect(termsReload.reload).toHaveBeenCalledTimes(1);
        expect(screen.getByRole('main')).toHaveAttribute('aria-busy', 'true');
      });
    });
  });

  describe('in the build that starts after the restart, with newer texts', () => {
    const afterRestart = (options: SetupOptions = {}) => setup({ ...options, termsReload: { refusedVersion: OLDER_VERSION } });

    it('opens on the consent screen with an empty box and says why the user is here again', async () => {
      const { api, termsReload } = afterRestart();

      expect(await screen.findByRole('heading', { level: 1, name: ru.consent.title })).toHaveFocus();
      const notice = screen.getByRole('note');
      expect(notice).toHaveTextContent(RENEWED);
      expect(notice).toHaveTextContent(ru.termsUpdate.renewed);
      expect(heading()).toHaveAccessibleDescription(ru.termsUpdate.renewed);
      expect(consentBox()).not.toBeChecked();
      expect(proceed()).toBeDisabled();
      // One restart is enough.
      expect(termsReload.reload).not.toHaveBeenCalled();
      expect(api.createChart).not.toHaveBeenCalled();
    });
  });

  describe('in the build that starts after the restart, with the same texts', () => {
    const stillOutdated = (options: SetupOptions = {}) => setup({ ...options, termsReload: { refusedVersion: CONSENT_VERSION } });

    it('says that the new version has not arrived, and asks for no data it could not use', async () => {
      const { api, termsReload } = stillOutdated();

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent(ru.termsUpdate.outdatedTitle);
      expect(alert).toHaveTextContent(ru.termsUpdate.outdatedText);
      expect(screen.queryByRole('button', { name: ru.welcome.start })).not.toBeInTheDocument();
      expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
      // No second restart on its own: that would be a loop.
      expect(termsReload.reload).not.toHaveBeenCalled();
      expect(api.createChart).not.toHaveBeenCalled();
    });

    it('restarts when the user asks, noting the version again so that the next start knows', async () => {
      const { termsReload, user } = stillOutdated();

      await user.click(await screen.findByRole('button', { name: ru.termsUpdate.reload }));

      expect(termsReload.remember).toHaveBeenCalledWith(CONSENT_VERSION);
      expect(termsReload.reload).toHaveBeenCalledTimes(1);
      expect(screen.getByRole('status')).toHaveTextContent(ru.common.loading);
    });
  });
});

describe('App: product events', () => {
  it('reports the way from the first screen to the chart, step by step', async () => {
    const { analytics, user } = setup();

    await fillIn(user);
    await user.click(await screen.findByRole('button', { name: ru.chart.share }));

    expect(analytics.events).toEqual([
      { name: 'app_open' },
      { name: 'screen_view', props: { step: 'welcome' } },
      { name: 'screen_view', props: { step: 'consent' } },
      { name: 'consent_view' },
      { name: 'consent_accepted', props: { version: CONSENT_VERSION } },
      { name: 'screen_view', props: { step: 'birth_date' } },
      { name: 'birth_date_done' },
      { name: 'screen_view', props: { step: 'birth_time' } },
      { name: 'birth_time_done' },
      { name: 'screen_view', props: { step: 'birth_place' } },
      { name: 'place_search' },
      { name: 'birth_place_done' },
      { name: 'screen_view', props: { step: 'chart' } },
      { name: 'chart_requested' },
      { name: 'chart_created' },
      { name: 'share_clicked' },
    ]);
  });

  it('reports every step back by the screen that was left, whichever control took the user there', async () => {
    const { analytics, telegram, user } = setup({ api: (fake) => fake.createChart.mockRejectedValue(apiError('VALIDATION_FAILED', { status: 422 })) });
    await fillIn(user);
    await screen.findByRole('alert');
    analytics.clear();

    // «Изменить данные» on the chart screen, then Telegram's Back twice, then «Не сейчас».
    await user.click(screen.getByRole('button', { name: ru.chart.editData }));
    act(() => {
      backHandler(telegram)?.();
    });
    await user.click(notNow());

    expect(analytics.events).toEqual([
      { name: 'step_back', props: { step: 'chart' } },
      { name: 'screen_view', props: { step: 'birth_date' } },
      { name: 'step_back', props: { step: 'birth_date' } },
      { name: 'screen_view', props: { step: 'consent' } },
      { name: 'consent_view' },
      { name: 'step_back', props: { step: 'consent' } },
      { name: 'screen_view', props: { step: 'welcome' } },
    ]);
  });

  describe('carry nothing the user entered', () => {
    /** Everything the user types or picks in these tests, and everything the chart says back. */
    const ENTERED = [
      '1994',
      '05-17',
      '17.05',
      '1705',
      '14:30',
      '1430',
      'Каз',
      'Казань',
      'Татарстан',
      '55.79',
      '49.1',
      'Europe',
      'Moscow',
      chartResult.chart.chart_id,
      'sig=',
    ];
    /** The only properties an event may have, and what each may hold. */
    const ALLOWED: Record<string, (value: unknown) => boolean> = {
      step: (value) => ['welcome', 'consent', 'privacy', 'terms', 'birth_date', 'birth_time', 'birth_place', 'chart'].includes(String(value)),
      code: (value) => /^[A-Z_]+$/.test(String(value)),
      field: (value) => /^[a-z_.]+$/.test(String(value)),
      version: (value) => value === CONSENT_VERSION,
    };

    /** A pass with a server rejection, a failed search and steps back in it: every kind of event the app has. */
    async function eventfulPass(view: ReturnType<typeof setup>) {
      const { api, telegram, user } = view;
      api.createChart
        .mockRejectedValueOnce(
          rejection(
            { field: 'birth_place', message: 'Не знаем такой часовой пояс — выбери город заново' },
            { field: 'birth_place.tz', message: 'Europe/Moscow' },
          ),
        )
        .mockResolvedValueOnce(chartResult);
      api.resolveGeo
        .mockResolvedValueOnce([kazan])
        .mockResolvedValueOnce([])
        .mockRejectedValueOnce(rejection({ field: 'query', message: 'Слишком длинный запрос — введи название города' }))
        .mockResolvedValue([kazan]);

      await fillIn(user);
      await screen.findAllByRole('alert');
      // Back on the place screen with the server's text: search again, three ways.
      const field = screen.getByLabelText(ru.birthPlace.label);
      await user.type(field, 'ск');
      await settleSearch();
      await user.type(field, 'ий');
      await settleSearch();
      await user.clear(field);
      await user.type(field, 'Казань');
      await settleSearch();
      await user.click(screen.getByRole('button', { name: /Казань/ }));
      act(() => {
        backHandler(telegram)?.();
      });
      await user.click(next());
      await user.click(buildChart());
      await user.click(await screen.findByRole('button', { name: ru.chart.share }));
    }

    it('in what goes to the server: the bodies of POST /events', async () => {
      const api = fakeApi();
      const sent = createAnalytics({ api, isEnabled: () => true, now: () => TODAY });
      const telegram = fakeTelegram();
      const user = setupUser();
      render(
        <App api={api} telegram={telegram} apiBaseUrl="https://api.test" track={sent.track} termsReload={fakeTermsReload()} today={TODAY} />,
      );
      await eventfulPass({ api, telegram, user } as ReturnType<typeof setup>);
      act(() => {
        sent.flush();
      });

      const batches = api.sendEvents.mock.calls.map(([events]) => events);
      const events = batches.flat();
      expect(events.length).toBeGreaterThan(20);
      for (const batch of batches) expect(batch.length).toBeLessThanOrEqual(20);
      for (const event of events) {
        expect(Object.keys(event).sort()).toEqual(event.props ? ['name', 'occurred_at', 'props'] : ['name', 'occurred_at']);
        expect(event.occurred_at).toBe(TODAY.toISOString());
        for (const [key, value] of Object.entries(event.props ?? {})) {
          expect(ALLOWED[key]?.(value), `${event.name}: ${key}=${String(value)}`).toBe(true);
        }
      }
      const body = JSON.stringify(batches);
      expect(body).not.toMatch(/\p{Script=Cyrillic}/u);
      for (const secret of ENTERED) expect(body).not.toContain(secret);
    });
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
