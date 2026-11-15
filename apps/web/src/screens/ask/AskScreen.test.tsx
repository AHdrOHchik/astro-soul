import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { useCallback, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QUESTION_MAX_LENGTH, type AskAnswer, type Me, type Quota } from '../../api';
import { formatMoment } from '../../i18n/format';
import { ru } from '../../i18n/ru';
import { apiError, askAnswer, chart, deferred, fakeAnalytics, fakeApi, meAsking, meSubscribed, rejection, setupUser } from '../../test/fixtures';
import { AskScreen, type AskScreenProps } from './AskScreen';

const copy = ru.ask;
const CHART_ID = chart.chart_id;
const QUESTION = 'На что опереться в работе?';
/** The texts of apps/api (`engagement.service.ts`, `ask-topics.ts`). */
const SERVER = {
  exhausted: 'На сегодня вопросы закончились. Лимит обновится в полночь по месту рождения',
  unavailable: 'Вопросы временно недоступны. Попробуй позже',
  chartGone: 'Такой карты нет. Построй карту заново',
  question: 'Вопрос — от 3 до 500 знаков',
  refusal:
    'Про это я не могу: здоровье, смерть, гарантии денег и юридические вопросы — не моя роль. С этим — к врачу, и как можно скорее, если вопрос срочный. А про свою карту спрашивай смело — про ритм, отношения, работу, выбор.',
};
/** Midnight by the clock of the device, and a moment that is not: built from local parts, so the tests read the same in any zone. */
const DEVICE_MIDNIGHT = new Date(2026, 10, 11, 0, 0);
const ELSEWHERE_MIDNIGHT = new Date(2026, 10, 10, 22, 0);

const quotaOf = (me: Me): Quota | null => me.quotas.find((quota) => quota.code === 'ask_daily') ?? null;
/** `429 QUOTA_EXCEEDED` as apps/api sends it for a question. */
const quotaExceeded = (message: string, resetAt: Date = DEVICE_MIDNIGHT) =>
  apiError('QUOTA_EXCEEDED', { status: 429, serverMessage: message, requestId: 'req-429', details: { quota_code: 'ask_daily', reset_at: resetAt.toISOString() } });

type HarnessProps = Omit<AskScreenProps, 'quota' | 'refreshMe'> & {
  /** What the app heard of the user before the screen opened. */
  heard: Me;
  /** `GET /me` of the moment. */
  getMe: (signal?: AbortSignal) => Promise<Me>;
};

/** Stands in for the app: keeps `Me`, hands its quota to the screen, and asks the server anew when the screen says so. */
function Harness({ heard, getMe, ...props }: HarnessProps) {
  const [me, setMe] = useState(heard);
  const refreshMe = useCallback(
    async (signal?: AbortSignal) => {
      const fresh = await getMe(signal);
      setMe(fresh);
      return fresh;
    },
    [getMe],
  );
  return <AskScreen {...props} quota={quotaOf(me)} refreshMe={refreshMe} />;
}

interface SetupOptions {
  /** What `GET /me` says now, or how it fails. A test changes `server.me` as the day goes on. */
  me?: Me | Error;
  /** What the app heard before the screen opened; what the server says unless the test says otherwise. */
  heard?: Me;
  /** Whether a subscription can be offered here. */
  offer?: boolean;
}

function setup({ me = meAsking(), heard, offer = true }: SetupOptions = {}) {
  const api = fakeApi();
  const analytics = fakeAnalytics();
  const server = { me };
  const getMe = vi
    .fn<HarnessProps['getMe']>()
    .mockImplementation(() => (server.me instanceof Error ? Promise.reject(server.me) : Promise.resolve(server.me)));
  const onSubscribe = vi.fn();
  const onChartGone = vi.fn();
  const user = setupUser();
  const view = render(
    <Harness
      api={api}
      chartId={CHART_ID}
      heard={heard ?? (me instanceof Error ? meAsking() : me)}
      getMe={getMe}
      track={analytics.track}
      onSubscribe={offer ? onSubscribe : undefined}
      onChartGone={onChartGone}
    />,
  );
  return { api, analytics, server, getMe, onSubscribe, onChartGone, user, ...view };
}

afterEach(() => {
  vi.useRealTimers();
});

const field = () => screen.getByRole<HTMLTextAreaElement>('textbox', { name: copy.fieldLabel });
const submit = () => screen.getByRole('button', { name: copy.submit });
/** Types the question. `fireEvent`, so that what follows it can happen in the very same tick. */
const typeQuestion = (text = QUESTION) => {
  fireEvent.change(field(), { target: { value: text } });
};
/** Lets everything that was waiting for an answer settle. */
const settle = () => act(async () => {});

/** Opens the screen and waits for the day's count. */
async function open(options: SetupOptions = {}) {
  const view = setup(options);
  await settle();
  return view;
}

/** Types a question, taps «Спросить» and waits for what the server said. */
async function ask(text = QUESTION) {
  typeQuestion(text);
  fireEvent.click(submit());
  await settle();
}

describe('AskScreen', () => {
  describe('the day\'s count, before anything is sent', () => {
    it('asks the server for it as the screen opens, and shows that answer, not what the app heard before', async () => {
      // The app heard «none asked» at its start; two were asked since, e.g. in the morning.
      const pending = deferred<Me>();
      const api = fakeApi();
      const getMe = vi.fn<HarnessProps['getMe']>().mockImplementation(() => pending.promise);
      render(<Harness api={api} chartId={CHART_ID} heard={meAsking({ used: 0 })} getMe={getMe} track={vi.fn()} onChartGone={vi.fn()} />);

      expect(getMe).toHaveBeenCalledTimes(1);
      // Not the number of the morning, and not any number: a placeholder, until the server answers.
      expect(screen.queryByText(/Сегодня ост/)).not.toBeInTheDocument();
      expect(screen.getByText(ru.common.loading)).toBeInTheDocument();
      // The field is there already: typing does not wait for the count.
      expect(field()).toBeInTheDocument();

      await act(async () => {
        pending.resolve(meAsking({ used: 2 }));
        await pending.promise;
      });
      expect(screen.getByText('Сегодня осталось 3 вопроса из 5')).toBeInTheDocument();
      expect(screen.queryByText(ru.common.loading)).not.toBeInTheDocument();
      expect(getMe).toHaveBeenCalledTimes(1);
      expect(api.ask).not.toHaveBeenCalled();
    });

    it.each([
      [4, 'Сегодня остался 1 вопрос из 5'],
      [3, 'Сегодня осталось 2 вопроса из 5'],
      [1, 'Сегодня осталось 4 вопроса из 5'],
      [0, 'Сегодня осталось 5 вопросов из 5'],
    ])('with %i of 5 asked says «%s»', async (used, line) => {
      await open({ me: meAsking({ used }) });
      expect(screen.getByText(line)).toBeInTheDocument();
    });

    it('says «Без ограничений» for a limit of -1, and never the number', async () => {
      await open({ me: meAsking({ used: 7, limit: -1 }) });
      expect(screen.getByText('Без ограничений')).toBeInTheDocument();
      expect(screen.getByRole('main')).not.toHaveTextContent('-1');
      expect(screen.queryByText(/Сегодня ост/)).not.toBeInTheDocument();
      expect(submit()).toBeInTheDocument();
    });

    it('shows no count when the server names no quota of questions, and still takes a question', async () => {
      const { getMe } = await open({ me: { ...meSubscribed, quotas: [] } });
      expect(getMe).toHaveBeenCalledTimes(1);
      expect(screen.queryByText(/Сегодня ост/)).not.toBeInTheDocument();
      expect(screen.queryByText(copy.unlimited)).not.toBeInTheDocument();
      expect(screen.queryByText(ru.common.loading)).not.toBeInTheDocument();
      expect(field()).toBeInTheDocument();
    });

    it('keeps the form back while the count the app heard before says «none left» and the server is asked whether that stands', async () => {
      const pending = deferred<Me>();
      const api = fakeApi();
      const analytics = fakeAnalytics();
      const getMe = vi.fn<HarnessProps['getMe']>().mockImplementation(() => pending.promise);
      render(<Harness api={api} chartId={CHART_ID} heard={meAsking({ used: 5 })} getMe={getMe} track={analytics.track} onChartGone={vi.fn()} />);

      // Neither a field that would be gone a moment later, nor «закончились» on the word of an old count.
      expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
      expect(screen.queryByRole('button')).not.toBeInTheDocument();
      expect(screen.queryByText(copy.exhausted)).not.toBeInTheDocument();
      expect(screen.getByRole('status')).toHaveTextContent(ru.common.loading);
      expect(analytics.events).toEqual([]);

      await act(async () => {
        pending.resolve(meAsking({ used: 5 }));
        await pending.promise;
      });
      expect(screen.getByText(copy.exhausted)).toBeInTheDocument();
      expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
      expect(analytics.events).toEqual([{ name: 'quota_exhausted', props: { step: 'ask' } }]);
    });

    it('and opens the form when the server says the old «none left» was another day\'s', async () => {
      const { api } = await open({ me: meAsking({ used: 0 }), heard: meAsking({ used: 5 }) });

      expect(screen.getByText('Сегодня осталось 5 вопросов из 5')).toBeInTheDocument();
      expect(screen.queryByText(copy.exhausted)).not.toBeInTheDocument();
      await ask();
      expect(api.ask).toHaveBeenCalledTimes(1);
    });

    it('shows no number when the server cannot be asked, and decides nothing by the one it heard before', async () => {
      // What the app heard is «all five asked»: yesterday's count, for all it knows. `Me` cannot be asked now.
      const { api } = await open({ me: apiError('NETWORK'), heard: meAsking({ used: 5 }) });

      expect(screen.queryByText(/Сегодня ост/)).not.toBeInTheDocument();
      expect(screen.queryByText(copy.exhausted)).not.toBeInTheDocument();
      expect(screen.queryByText(ru.common.loading)).not.toBeInTheDocument();
      // The question can still be asked: the server counts, and says so itself when the limit is reached.
      await ask();
      expect(api.ask).toHaveBeenCalledTimes(1);
      expect(screen.getByText(askAnswer.answer)).toBeInTheDocument();
    });
  });

  describe('sending', () => {
    it('one tap is one request: a second tap in the same tick sends nothing', async () => {
      const { api } = await open();
      // The server is slow to answer: both taps land before it does.
      api.ask.mockImplementation(() => new Promise<never>(() => undefined));
      typeQuestion(`  ${QUESTION}  `);

      const button = submit();
      // Two taps before the screen has drawn anything in answer to the first: nothing on it is disabled yet.
      act(() => {
        fireEvent.click(button);
        fireEvent.click(button);
      });
      await settle();

      expect(api.ask).toHaveBeenCalledTimes(1);
      // The question goes out trimmed, as the server counts its length.
      expect(api.ask).toHaveBeenCalledWith({ chart_id: CHART_ID, question: QUESTION }, expect.any(AbortSignal));
    });

    it('takes no second question while the first is on its way: by tap, by the form, or by a changed text', async () => {
      const pending = deferred<AskAnswer>();
      const { api } = await open();
      api.ask.mockImplementation(() => pending.promise);
      typeQuestion();
      fireEvent.click(submit());
      await settle();

      const sending = screen.getByRole('button', { name: copy.sending });
      expect(sending).toBeDisabled();
      expect(field()).toHaveAttribute('readonly');
      expect(screen.getByRole('main')).toHaveAttribute('aria-busy', 'true');

      fireEvent.click(sending);
      fireEvent.submit(field().closest('form') as HTMLFormElement);
      await settle();
      expect(api.ask).toHaveBeenCalledTimes(1);

      await act(async () => {
        pending.resolve(askAnswer);
        await pending.promise;
      });
      expect(submit()).toBeInTheDocument();
      expect(field()).not.toHaveAttribute('readonly');
      expect(screen.getByRole('main')).not.toHaveAttribute('aria-busy', 'true');
    });

    it('shows the answer as the server wrote it, with the question it answers and what it rests on', async () => {
      const { api, analytics, getMe, server } = await open({ me: meAsking({ used: 2 }) });
      expect(screen.getByText('Сегодня осталось 3 вопроса из 5')).toBeInTheDocument();
      analytics.clear();

      // The server counts the question; the screen does not.
      server.me = meAsking({ used: 3 });
      await ask();

      const answer = within(screen.getByRole('region', { name: copy.answer }));
      expect(answer.getByText(QUESTION)).toBeInTheDocument();
      expect(answer.getByText(askAnswer.answer)).toBeInTheDocument();
      expect(answer.getByRole('heading', { name: 'На чём основано' })).toBeInTheDocument();
      expect(answer.getAllByRole('listitem').map((item) => item.textContent)).toEqual(['Солнце в Тельце', 'Луна в Раке']);
      // Not a failure and not announced as one.
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();

      // The field is ready for the next question, and the count is the server's new one.
      expect(field()).toHaveValue('');
      expect(getMe).toHaveBeenCalledTimes(2);
      expect(screen.getByText('Сегодня осталось 2 вопроса из 5')).toBeInTheDocument();
      expect(api.ask).toHaveBeenCalledTimes(1);
      expect(analytics.events).toEqual([{ name: 'ask_used' }]);
    });

    it('has no «На чём основано» when the server named nothing the answer rests on', async () => {
      const { api } = await open();
      api.ask.mockResolvedValue({ answer: 'Ответ без опоры.', based_on: [] });
      await ask();
      expect(screen.getByText('Ответ без опоры.')).toBeInTheDocument();
      expect(screen.queryByText(copy.basedOn)).not.toBeInTheDocument();
      expect(screen.queryByRole('list')).not.toBeInTheDocument();
    });

    it('shows a refusal to speak on a topic as what it is: the server\'s answer, word for word', async () => {
      const { api, analytics, server } = await open({ me: meAsking({ used: 2 }) });
      // The server counts no question for a refusal.
      server.me = meAsking({ used: 2 });
      api.ask.mockResolvedValue({ answer: SERVER.refusal, based_on: [] });
      analytics.clear();
      await ask('Какой у меня диагноз?');

      expect(within(screen.getByRole('region', { name: copy.answer })).getByText(SERVER.refusal)).toBeInTheDocument();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(screen.queryByText(copy.basedOn)).not.toBeInTheDocument();
      expect(screen.queryByText(copy.failedTitle, { exact: false })).not.toBeInTheDocument();
      expect(screen.getByText('Сегодня осталось 3 вопроса из 5')).toBeInTheDocument();
      // An answer like any other for the events as well: what it said is not theirs to tell.
      expect(analytics.events).toEqual([{ name: 'ask_used' }]);
    });

    it('puts the next question and its answer in place of the previous pair', async () => {
      const { api } = await open();
      await ask('Первый вопрос?');
      expect(screen.getByText('Первый вопрос?')).toBeInTheDocument();

      api.ask.mockResolvedValue({ answer: 'Ответ на второй вопрос.', based_on: ['Марс в Деве'] });
      await ask('Второй вопрос?');

      expect(screen.getByText('Второй вопрос?')).toBeInTheDocument();
      expect(screen.getByText('Ответ на второй вопрос.')).toBeInTheDocument();
      expect(screen.queryByText('Первый вопрос?')).not.toBeInTheDocument();
      expect(screen.queryByText(askAnswer.answer)).not.toBeInTheDocument();
      expect(screen.getAllByRole('listitem').map((item) => item.textContent)).toEqual(['Марс в Деве']);
      expect(api.ask).toHaveBeenCalledTimes(2);
    });

    it('sends nothing while there is nothing to ask: an empty field, or spaces alone', async () => {
      const { api } = await open();
      expect(submit()).toBeDisabled();

      typeQuestion('   \n  ');
      expect(submit()).toBeDisabled();
      fireEvent.submit(field().closest('form') as HTMLFormElement);
      await settle();
      expect(api.ask).not.toHaveBeenCalled();

      typeQuestion('Вопрос');
      expect(submit()).toBeEnabled();
    });

    it('keeps a question within the 500 characters of the contract, and shows how many are typed', async () => {
      await open();
      expect(field()).toHaveAttribute('maxlength', String(QUESTION_MAX_LENGTH));
      expect(screen.getByText('0 / 500')).toBeInTheDocument();

      typeQuestion('Вопрос');
      expect(screen.getByText('6 / 500')).toBeInTheDocument();
      expect(screen.getByText('Набрано знаков: 6 из 500')).toBeInTheDocument();

      // A paste the browser did not cut.
      typeQuestion('я'.repeat(QUESTION_MAX_LENGTH + 100));
      expect(field().value).toHaveLength(QUESTION_MAX_LENGTH);
      expect(screen.getByText('500 / 500')).toBeInTheDocument();
    });
  });

  describe('the day\'s questions are used up', () => {
    it('by the server\'s count: says so calmly before anything is typed, with no field and no button to send from', async () => {
      const { api, analytics, onSubscribe, user } = await open({ me: meAsking({ used: 5, reset_at: DEVICE_MIDNIGHT.toISOString() }) });

      const state = screen.getByRole('status');
      expect(state).toHaveTextContent('Вопросы на сегодня закончились. Новые — после полуночи.');
      expect(state).toHaveTextContent(`Обновится ${formatMoment(DEVICE_MIDNIGHT)}.`);
      // A state of the day, not a failure.
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: copy.submit })).not.toBeInTheDocument();
      expect(screen.queryByText(/Сегодня ост/)).not.toBeInTheDocument();

      // The quiet way to the paywall is the only button there is.
      const offer = screen.getByRole('button', { name: 'В подписке 5 вопросов в день' });
      expect(screen.getAllByRole('button')).toEqual([offer]);
      await user.click(offer);
      expect(onSubscribe).toHaveBeenCalledTimes(1);

      expect(api.ask).not.toHaveBeenCalled();
      expect(analytics.events).toEqual([{ name: 'quota_exhausted', props: { step: 'ask' } }]);
    });

    it('speaks of no subscription where there is none to offer: to a subscriber, or in a build that sells none', async () => {
      await open({ me: meAsking({ used: 5 }), offer: false });
      expect(screen.getByRole('status')).toHaveTextContent(copy.exhausted);
      expect(screen.queryByText(copy.subscriptionOffer)).not.toBeInTheDocument();
      expect(screen.queryByText(/подписк/i)).not.toBeInTheDocument();
      expect(screen.queryByRole('button')).not.toBeInTheDocument();
    });

    it('names whose midnight it is when the limit lifts at another hour by the user\'s own clock', async () => {
      await open({ me: meAsking({ used: 5, reset_at: ELSEWHERE_MIDNIGHT.toISOString() }) });
      const state = screen.getByRole('status');
      expect(state).toHaveTextContent(`Обновится ${formatMoment(ELSEWHERE_MIDNIGHT)}. Полночь считается по месту рождения.`);
    });

    it('does not explain the midnight that is midnight for the user as well', async () => {
      await open({ me: meAsking({ used: 5, reset_at: DEVICE_MIDNIGHT.toISOString() }) });
      expect(screen.getByRole('status')).not.toHaveTextContent(copy.resetsElsewhere);
    });

    it('with the last question: the answer stays, and the field gives way to «закончились»', async () => {
      const { analytics, server } = await open({ me: meAsking({ used: 4 }) });
      expect(screen.getByText('Сегодня остался 1 вопрос из 5')).toBeInTheDocument();
      analytics.clear();

      server.me = meAsking({ used: 5 });
      await ask();

      expect(screen.getByText(askAnswer.answer)).toBeInTheDocument();
      expect(screen.getByText(copy.exhausted)).toBeInTheDocument();
      expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: copy.submit })).not.toBeInTheDocument();
      expect(analytics.events).toEqual([{ name: 'ask_used' }, { name: 'quota_exhausted', props: { step: 'ask' } }]);
    });

    describe('429 to a question', () => {
      it('and `Me` confirms that none are left: the same calm state, with the moment the server named', async () => {
        // The count the screen opened with said «one left»: it was asked from another device since.
        const { api, analytics, onSubscribe, server } = await open({ me: meAsking({ used: 4 }) });
        analytics.clear();
        api.ask.mockRejectedValue(quotaExceeded(SERVER.exhausted, ELSEWHERE_MIDNIGHT));
        server.me = meAsking({ used: 5, reset_at: DEVICE_MIDNIGHT.toISOString() });
        await ask();

        const state = screen.getByRole('status');
        expect(state).toHaveTextContent(copy.exhausted);
        // The moment of the refusal itself, not the one `Me` carries.
        expect(state).toHaveTextContent(`Обновится ${formatMoment(ELSEWHERE_MIDNIGHT)}.`);
        expect(screen.queryByRole('alert')).not.toBeInTheDocument();
        expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
        expect(screen.getByRole('button', { name: copy.subscriptionOffer })).toBeInTheDocument();
        expect(onSubscribe).not.toHaveBeenCalled();
        expect(api.ask).toHaveBeenCalledTimes(1);
        // Not a failure for the events either.
        expect(analytics.events).toEqual([{ name: 'quota_exhausted', props: { step: 'ask' } }]);
      });

      it('while `Me` says there are questions left: the limit is not the user\'s, so only the server\'s words are shown', async () => {
        const { api, analytics } = await open({ me: meAsking({ used: 2 }) });
        analytics.clear();
        // The month's budget of the service is spent: the same code, another text, and the user's own count untouched.
        api.ask.mockRejectedValue(quotaExceeded(SERVER.unavailable));
        await ask();

        expect(screen.getByText(SERVER.unavailable)).toBeInTheDocument();
        // Nothing about the day's questions or a subscription: neither is what stopped the question.
        expect(screen.queryByText(copy.exhausted)).not.toBeInTheDocument();
        expect(screen.queryByText(copy.subscriptionOffer)).not.toBeInTheDocument();
        expect(screen.queryByText(/Обновится/)).not.toBeInTheDocument();
        expect(screen.queryByRole('alert')).not.toBeInTheDocument();
        // The question is kept: it can be sent again later.
        expect(field()).toHaveValue(QUESTION);
        expect(screen.getByText('Сегодня осталось 3 вопроса из 5')).toBeInTheDocument();
        expect(api.ask).toHaveBeenCalledTimes(1);
        // Not the user's quota, and not counted as one: a question that got no answer.
        expect(analytics.events).toEqual([{ name: 'error_shown', props: { screen: 'ask', code: '429' } }]);

        // Sent again by the user's tap alone, and counted again when refused again.
        fireEvent.click(submit());
        await settle();
        expect(api.ask).toHaveBeenCalledTimes(2);
        expect(analytics.events).toEqual([
          { name: 'error_shown', props: { screen: 'ask', code: '429' } },
          { name: 'error_shown', props: { screen: 'ask', code: '429' } },
        ]);
      });

      it('while `Me` cannot be asked: the server\'s own words about the limit, and nothing decided by an old count', async () => {
        const { api, analytics, server } = await open({ me: meAsking({ used: 4 }) });
        analytics.clear();
        api.ask.mockRejectedValue(quotaExceeded(SERVER.exhausted));
        server.me = apiError('NETWORK');
        await ask();

        expect(screen.getByText(SERVER.exhausted)).toBeInTheDocument();
        expect(screen.queryByText(/Сегодня ост/)).not.toBeInTheDocument();
        expect(screen.queryByText(copy.exhausted)).not.toBeInTheDocument();
        expect(field()).toHaveValue(QUESTION);
        // The refusal is all there is to go by, and it says the limit is reached.
        expect(analytics.events).toEqual([{ name: 'quota_exhausted', props: { step: 'ask' } }]);

        // Met again in the same opening, it is not counted again.
        fireEvent.click(submit());
        await settle();
        expect(api.ask).toHaveBeenCalledTimes(2);
        expect(analytics.names()).toEqual(['quota_exhausted']);
      });

      it('falls back on the app\'s own words when the server sent none with the refusal', async () => {
        const { api } = await open({ me: meAsking({ used: 2 }) });
        api.ask.mockRejectedValue(apiError('QUOTA_EXCEEDED', { status: 429 }));
        await ask();
        expect(screen.getByText(ru.errors.QUOTA_EXCEEDED.text)).toBeInTheDocument();
      });
    });
  });

  describe('what the server refuses', () => {
    it('422: its words under the field with the request id, the question kept, and gone once the question is changed', async () => {
      const { api, analytics, getMe } = await open();
      analytics.clear();
      api.ask.mockRejectedValue(rejection({ field: 'question', message: SERVER.question }));
      await ask('Что?');

      expect(screen.getByText(SERVER.question)).toBeInTheDocument();
      expect(field()).toHaveAttribute('aria-invalid', 'true');
      expect(field()).toHaveValue('Что?');
      expect(screen.getByText(ru.common.requestId('req-422'))).toBeInTheDocument();
      // Said at the field, once: not a second time as a failure of the screen.
      expect(screen.queryByText(copy.failedTitle, { exact: false })).not.toBeInTheDocument();
      expect(analytics.events).toEqual([
        { name: 'validation_failed', props: { step: 'ask', code: 'VALIDATION_FAILED', field: 'question' } },
        { name: 'error_shown', props: { screen: 'ask', code: '422' } },
      ]);
      expect(getMe).toHaveBeenCalledTimes(2);

      typeQuestion('Что мне важно понять про работу?');
      expect(screen.queryByText(SERVER.question)).not.toBeInTheDocument();
      expect(field()).not.toHaveAttribute('aria-invalid');
    });

    it('422 without the server\'s own words: says that the question was not accepted', async () => {
      const { api } = await open();
      api.ask.mockRejectedValue(apiError('VALIDATION_FAILED', { status: 422 }));
      await ask();
      expect(screen.getByText(copy.rejected)).toBeInTheDocument();
    });

    it('404: the chart is gone. The app leads on, and nothing of the server\'s answer is shown', async () => {
      const { api, analytics, onChartGone } = await open();
      analytics.clear();
      api.ask.mockRejectedValue(apiError('NOT_FOUND', { status: 404, serverMessage: SERVER.chartGone, requestId: 'req-404' }));
      await ask();

      expect(onChartGone).toHaveBeenCalledTimes(1);
      expect(screen.queryByText(SERVER.chartGone)).not.toBeInTheDocument();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(screen.queryByText(ru.common.requestId('req-404'))).not.toBeInTheDocument();
      // Nothing failed that the user was shown.
      expect(analytics.events).toEqual([]);
    });

    it('a failed request: says that no answer came, keeps the question, and sends it again only by a tap', async () => {
      const { api, analytics } = await open();
      analytics.clear();
      api.ask.mockRejectedValueOnce(apiError('NETWORK'));
      await ask();

      const alert = screen.getByRole('alert');
      expect(alert).toHaveTextContent('Ответ не получен');
      expect(alert).toHaveTextContent(ru.errors.NETWORK.text);
      expect(field()).toHaveValue(QUESTION);
      expect(api.ask).toHaveBeenCalledTimes(1);
      expect(analytics.events).toEqual([{ name: 'error_shown', props: { screen: 'ask', code: 'NETWORK' } }]);

      fireEvent.click(submit());
      await settle();
      expect(api.ask).toHaveBeenCalledTimes(2);
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(screen.getByText(askAnswer.answer)).toBeInTheDocument();
    });

    it('a server failure: its own words and its request id', async () => {
      const { api, analytics } = await open();
      analytics.clear();
      api.ask.mockRejectedValue(apiError('INTERNAL', { status: 500, serverMessage: 'Что-то сломалось на нашей стороне. Мы уже разбираемся.', requestId: 'req-500' }));
      await ask();

      const alert = screen.getByRole('alert');
      expect(alert).toHaveTextContent('Что-то сломалось на нашей стороне. Мы уже разбираемся.');
      expect(within(alert).getByText(ru.common.requestId('req-500'))).toBeInTheDocument();
      expect(analytics.events).toEqual([{ name: 'error_shown', props: { screen: 'ask', code: '500' } }]);
    });
  });

  it('reports not a word of the question or of the answer', async () => {
    const { api, analytics, server } = await open();
    await ask();
    api.ask.mockRejectedValueOnce(rejection({ field: 'question', message: SERVER.question }));
    await ask('Что?');
    api.ask.mockRejectedValueOnce(quotaExceeded(SERVER.unavailable));
    await ask('Ещё один вопрос?');
    api.ask.mockRejectedValueOnce(quotaExceeded(SERVER.exhausted));
    server.me = meAsking({ used: 5 });
    await ask('И ещё один?');

    expect(analytics.names()).toEqual(['ask_used', 'validation_failed', 'error_shown', 'error_shown', 'quota_exhausted']);
    expect(JSON.stringify(analytics.events)).not.toMatch(/[А-Яа-яЁё]/);
  });

  it('drops the request when the screen is left, and an answer that comes after that changes nothing', async () => {
    const pending = deferred<AskAnswer>();
    const { api, analytics, getMe, unmount } = await open();
    analytics.clear();
    api.ask.mockImplementation(() => pending.promise);
    typeQuestion();
    fireEvent.click(submit());
    await settle();

    const signal = api.ask.mock.calls[0]?.[1];
    expect(signal?.aborted).toBe(false);
    unmount();
    expect(signal?.aborted).toBe(true);

    await act(async () => {
      pending.resolve(askAnswer);
      await pending.promise;
    });
    expect(analytics.events).toEqual([]);
    expect(getMe).toHaveBeenCalledTimes(1);
  });
});
