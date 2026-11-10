import { act, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GeoPlace } from '../api';
import { SEARCH_DEBOUNCE_MS } from '../hooks/usePlaceSearch';
import { ru } from '../i18n/ru';
import { apiError, deferred, fakeApi, fakeTelegram, kazan, kazanka, rejection, setupUser } from '../test/fixtures';
import { BirthPlaceScreen } from './BirthPlaceScreen';

const copy = ru.birthPlace;

function setup(initial: { query?: string; place?: GeoPlace | null; serverError?: string } = {}) {
  const api = fakeApi();
  const onNext = vi.fn();
  const onChange = vi.fn();
  const user = setupUser();
  function Harness() {
    const [query, setQuery] = useState(initial.query ?? '');
    const [place, setPlace] = useState(initial.place ?? null);
    return (
      <BirthPlaceScreen
        api={api}
        telegram={fakeTelegram()}
        query={query}
        place={place}
        serverError={initial.serverError}
        onChange={(nextQuery, nextPlace) => {
          onChange(nextQuery, nextPlace);
          setQuery(nextQuery);
          setPlace(nextPlace);
        }}
        onNext={onNext}
      />
    );
  }
  render(<Harness />);
  const settle = () => act(() => vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS));
  return {
    api,
    user,
    onNext,
    onChange,
    settle,
    input: screen.getByLabelText<HTMLInputElement>(copy.label),
    submit: screen.getByRole('button', { name: copy.submit }),
  };
}

const results = () => within(screen.getByRole('list', { name: copy.resultsLabel })).getAllByRole('button');

afterEach(() => {
  vi.useRealTimers();
});

describe('BirthPlaceScreen', () => {
  it('does not search before three characters', async () => {
    const { api, user, input, settle } = setup();
    expect(input).toHaveFocus();
    expect(screen.getByText(copy.minLength(3))).toBeInTheDocument();

    await user.type(input, 'Ка');
    await settle();

    expect(api.resolveGeo).not.toHaveBeenCalled();
  });

  it('searches once after the user stops typing and lists the places with their time zones', async () => {
    const { api, user, input, settle } = setup();

    await user.type(input, 'Каз');
    expect(api.resolveGeo).not.toHaveBeenCalled();
    expect(screen.getByRole('status')).toHaveTextContent(copy.searching);

    await settle();

    expect(api.resolveGeo).toHaveBeenCalledTimes(1);
    expect(api.resolveGeo).toHaveBeenCalledWith('Каз', expect.any(AbortSignal));
    const [first, second] = results();
    expect(first).toHaveTextContent('Казань');
    expect(first).toHaveTextContent('Татарстан, Россия · Europe/Moscow');
    expect(second).toHaveTextContent('Казанка');
    expect(screen.getByRole('status')).toHaveTextContent(copy.found(2));
  });

  it('takes the time zone from the chosen place and passes the API object on untouched', async () => {
    const { user, input, settle, submit, onChange, onNext } = setup();
    await user.type(input, 'Каз');
    await settle();

    await user.click(screen.getByRole('button', { name: /Казань/ }));

    expect(onChange).toHaveBeenLastCalledWith('Казань', kazan);
    expect(onChange.mock.lastCall?.[1]).toBe(kazan);
    expect(input).toHaveValue('Казань');
    expect(screen.getByText(copy.timezone('Europe/Moscow'))).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: copy.resultsLabel })).not.toBeInTheDocument();
    expect(submit).toHaveFocus();

    await user.click(submit);
    expect(onNext).toHaveBeenCalledTimes(1);
  });

  it('does not search again for the name of the place that was just chosen', async () => {
    const { api, user, input, settle } = setup();
    await user.type(input, 'Каз');
    await settle();
    await user.click(screen.getByRole('button', { name: /Казань/ }));
    await settle();
    expect(api.resolveGeo).toHaveBeenCalledTimes(1);
  });

  it('drops the chosen place as soon as the text changes', async () => {
    const { user, input, onChange, settle } = setup({ query: 'Казань', place: kazan });
    expect(input).not.toHaveFocus();

    await user.type(input, 'к');
    await settle();

    expect(onChange).toHaveBeenLastCalledWith('Казаньк', null);
    expect(screen.queryByText(copy.timezone('Europe/Moscow'))).not.toBeInTheDocument();
  });

  it('lets the user pick another place without retyping', async () => {
    const { user, input, settle } = setup({ query: 'Казань', place: kazan });

    await user.click(screen.getByRole('button', { name: copy.change }));
    await settle();

    expect(input).toHaveFocus();
    expect(input).toHaveValue('Казань');
    expect(results()).toHaveLength(2);
  });

  it('says so when nothing is found', async () => {
    const { api, user, input, settle } = setup();
    api.resolveGeo.mockResolvedValue([]);

    await user.type(input, 'Ыыы');
    await settle();

    const empty = screen.getByText(copy.emptyTitle).closest('[role="status"]');
    expect(empty).toHaveTextContent(copy.emptyText);
    expect(screen.queryByRole('list', { name: copy.resultsLabel })).not.toBeInTheDocument();
  });

  it('shows a failure, not "nothing found", for a 404, and keeps a text that is not Russian off the screen', async () => {
    const { api, user, input, settle } = setup();
    // A missing route, in the words of a server framework rather than of the API.
    api.resolveGeo.mockRejectedValue(
      apiError('NOT_FOUND', { status: 404, serverMessage: 'Cannot POST /api/v1/geo/resolve', requestId: 'req-404' }),
    );

    await user.type(input, 'Моск');
    await settle();

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(ru.errors.NOT_FOUND.title);
    expect(alert).toHaveTextContent(ru.errors.NOT_FOUND.text);
    expect(screen.getByText(ru.common.requestId('req-404'))).toBeInTheDocument();
    expect(screen.queryByText(copy.emptyTitle)).not.toBeInTheDocument();
    expect(screen.queryByText(/Cannot POST/)).not.toBeInTheDocument();
  });

  it('shows the error with a retry that repeats the search', async () => {
    const { api, user, input, settle } = setup();
    api.resolveGeo.mockRejectedValueOnce(apiError('RATE_LIMITED', { status: 429, serverMessage: 'Слишком часто.', requestId: 'req-7' }));

    await user.type(input, 'Каз');
    await settle();

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(ru.errors.RATE_LIMITED.title);
    expect(alert).toHaveTextContent('Слишком часто.');
    expect(screen.getByText(ru.common.requestId('req-7'))).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: ru.common.retry }));
    await settle();

    expect(api.resolveGeo).toHaveBeenCalledTimes(2);
    expect(results()).toHaveLength(2);
  });

  it('says that the search is down, not that the place does not exist, when the geodata provider fails; a retry repeats the search', async () => {
    const { api, user, input, settle } = setup();
    api.resolveGeo.mockRejectedValueOnce(apiError('GEO_NOT_FOUND', { status: 503, requestId: 'req-503' }));

    await user.type(input, 'Каз');
    await settle();

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(ru.errors.GEO_NOT_FOUND.title);
    expect(alert).toHaveTextContent(ru.errors.GEO_NOT_FOUND.text);
    expect(screen.queryByText(copy.emptyTitle)).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: ru.common.retry }));
    await settle();

    expect(api.resolveGeo).toHaveBeenCalledTimes(2);
    expect(results()).toHaveLength(2);
  });

  it('shows what the server says about the query at the field, where the query is', async () => {
    const { api, user, input, settle } = setup();
    api.resolveGeo.mockRejectedValue(rejection({ field: 'query', message: 'Слишком длинный запрос — введи название города' }));

    await user.type(input, 'Каз');
    await settle();

    const alerts = screen.getAllByRole('alert');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toHaveTextContent('Слишком длинный запрос — введи название города');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAccessibleDescription('Слишком длинный запрос — введи название города');
    expect(screen.queryByText(ru.errors.VALIDATION_FAILED.title)).not.toBeInTheDocument();
  });

  it('never shows the answer to an outdated query', async () => {
    const { api, user, input, settle } = setup();
    const slow = deferred<GeoPlace[]>();
    api.resolveGeo.mockImplementationOnce(() => slow.promise).mockResolvedValueOnce([kazanka]);

    await user.type(input, 'Каз');
    await settle();
    const firstSignal = api.resolveGeo.mock.calls[0]?.[1];
    await user.type(input, 'анк');
    await settle();

    expect(firstSignal?.aborted).toBe(true);
    await act(async () => {
      slow.resolve([kazan]);
      await slow.promise;
    });

    expect(api.resolveGeo).toHaveBeenLastCalledWith('Казанк', expect.any(AbortSignal));
    expect(results()).toHaveLength(1);
    expect(results()[0]).toHaveTextContent('Казанка');
  });

  it('remembers answers, so going back to an earlier query costs no request', async () => {
    const { api, user, input, settle } = setup();
    await user.type(input, 'Каз');
    await settle();
    await user.type(input, 'а');
    await settle();
    expect(api.resolveGeo).toHaveBeenCalledTimes(2);

    await user.type(input, '{Backspace}');
    await settle();

    expect(api.resolveGeo).toHaveBeenCalledTimes(2);
    expect(results()).toHaveLength(2);
  });

  it('does not continue without a chosen place', async () => {
    const { user, input, submit, onNext } = setup();

    await user.click(submit);

    expect(screen.getByRole('alert')).toHaveTextContent(copy.choosePlace);
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveFocus();
    expect(onNext).not.toHaveBeenCalled();

    await user.type(input, 'К');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  describe('with a place the server rejected', () => {
    const REJECTED = 'Не знаем такой часовой пояс — выбери город заново';

    it('shows the server text at the field, keeps the place on screen and puts the cursor into the field', () => {
      const { input } = setup({ query: 'Казань', place: kazan, serverError: REJECTED });

      expect(screen.getByRole('alert')).toHaveTextContent(REJECTED);
      expect(input).toHaveAttribute('aria-invalid', 'true');
      expect(input).toHaveAccessibleDescription(REJECTED);
      expect(input).toHaveFocus();
      expect(screen.getByText(copy.timezone('Europe/Moscow'))).toBeInTheDocument();
    });

    it('lets the user go on with the same place: only the server can tell whether its verdict still stands', async () => {
      const { user, submit, onNext } = setup({ query: 'Казань', place: kazan, serverError: REJECTED });
      await user.click(submit);
      expect(onNext).toHaveBeenCalledTimes(1);
    });
  });

  it('treats the keyboard Search key as "show results", not as "continue"', async () => {
    const { user, input, settle, onNext } = setup();
    await user.type(input, 'Каз{Enter}');
    await settle();

    expect(onNext).not.toHaveBeenCalled();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(input).not.toHaveFocus();
    expect(results()).toHaveLength(2);
  });
});
