import { act, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GeoPlace } from '../api';
import { SEARCH_DEBOUNCE_MS } from '../hooks/usePlaceSearch';
import { ru } from '../i18n/ru';
import { apiError, deferred, fakeApi, fakeTelegram, kazan, kazanka, setupUser } from '../test/fixtures';
import { BirthPlaceScreen } from './BirthPlaceScreen';

const copy = ru.birthPlace;

function setup(initial: { query?: string; place?: GeoPlace | null } = {}) {
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
