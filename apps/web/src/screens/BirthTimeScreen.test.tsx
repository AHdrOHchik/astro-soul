import { render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TimePrecision } from '../api';
import { ru } from '../i18n/ru';
import type { TimeParts } from '../lib/birth';
import { setupUser } from '../test/fixtures';
import { BirthTimeScreen, type BirthTimeScreenProps } from './BirthTimeScreen';

const copy = ru.birthTime;

function setup(
  initialMode: TimePrecision | null = null,
  initialTime: TimeParts = { hours: '', minutes: '' },
  rejected: Pick<BirthTimeScreenProps, 'precisionError' | 'timeError'> = {},
) {
  const onNext = vi.fn();
  const user = setupUser();
  function Harness() {
    const [mode, setMode] = useState(initialMode);
    const [time, setTime] = useState(initialTime);
    return <BirthTimeScreen mode={mode} time={time} {...rejected} onModeChange={setMode} onTimeChange={setTime} onNext={onNext} />;
  }
  render(<Harness />);
  const option = (mode: TimePrecision) => screen.getByRole('radio', { name: copy.options[mode].title });
  return { user, onNext, option, next: screen.getByRole('button', { name: ru.common.next }) };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('BirthTimeScreen', () => {
  it('offers exactly three options and preselects none', () => {
    const { option } = setup();
    expect(screen.getAllByRole('radio')).toHaveLength(3);
    for (const mode of ['exact', 'approximate', 'unknown'] as const) expect(option(mode)).not.toBeChecked();
    expect(screen.queryByLabelText(copy.hours)).not.toBeInTheDocument();
  });

  it('asks for a choice before going on', async () => {
    const { user, next, onNext } = setup();
    await user.click(next);
    expect(screen.getByRole('alert')).toHaveTextContent(copy.chooseOption);
    expect(onNext).not.toHaveBeenCalled();
  });

  it('"I don\'t know" needs no time and warns that the Ascendant and houses are not calculated', async () => {
    const { user, option, next, onNext } = setup();

    await user.click(option('unknown'));

    expect(screen.getByRole('note')).toHaveTextContent(copy.options.unknown.accuracy);
    expect(screen.queryByLabelText(copy.hours)).not.toBeInTheDocument();
    await user.click(next);
    expect(onNext).toHaveBeenCalledTimes(1);
  });

  it('"roughly" asks for a time and warns honestly about the accuracy', async () => {
    const { user, option, next, onNext } = setup();

    await user.click(option('approximate'));

    expect(screen.getByRole('note')).toHaveTextContent(copy.options.approximate.accuracy);
    const hours = screen.getByLabelText<HTMLInputElement>(copy.hours);
    const minutes = screen.getByLabelText<HTMLInputElement>(copy.minutes);
    expect(hours).toHaveFocus();

    await user.keyboard('1430');

    expect([hours.value, minutes.value]).toEqual(['14', '30']);
    expect(next).toHaveFocus();
    await user.click(next);
    expect(onNext).toHaveBeenCalledTimes(1);
  });

  it('brings the warning into view when no field does it: "I don\'t know" on a small screen', async () => {
    const scrollIntoView = vi.spyOn(Element.prototype, 'scrollIntoView');
    const { user, option } = setup();

    await user.click(option('approximate'));
    expect(scrollIntoView).not.toHaveBeenCalled();

    await user.click(option('unknown'));
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView.mock.contexts[0]).toHaveTextContent(copy.options.unknown.accuracy);
  });

  it('does not scroll on its own when the screen is reopened with "I don\'t know" already chosen', () => {
    const scrollIntoView = vi.spyOn(Element.prototype, 'scrollIntoView');
    setup('unknown');
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it('"exactly" explains why minutes matter', async () => {
    const { user, option } = setup();
    await user.click(option('exact'));
    expect(screen.getByRole('note')).toHaveTextContent(copy.options.exact.accuracy);
    expect(screen.getByLabelText(copy.hours)).toBeInTheDocument();
  });

  it('pads a minute that cannot grow and moves on', async () => {
    const { user, option, next } = setup();
    await user.click(option('exact'));
    await user.keyboard('97');
    expect(screen.getByLabelText(copy.hours)).toHaveValue('09');
    expect(screen.getByLabelText(copy.minutes)).toHaveValue('07');
    expect(next).toHaveFocus();
  });

  it('rejects a time that does not exist', async () => {
    const { user, option, next, onNext } = setup();
    await user.click(option('exact'));
    await user.keyboard('2500');
    expect(screen.getByRole('alert')).toHaveTextContent(copy.issues.invalid);
    await user.click(next);
    expect(onNext).not.toHaveBeenCalled();
  });

  it('requires the time once "exactly" or "roughly" is chosen', async () => {
    const { user, option, next, onNext } = setup();
    await user.click(option('exact'));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    await user.click(next);

    expect(screen.getByRole('alert')).toHaveTextContent(copy.issues.incomplete);
    expect(onNext).not.toHaveBeenCalled();
    expect(screen.getByLabelText(copy.hours)).toHaveFocus();
  });

  it('does not greet a freshly shown time field with an error left from an earlier attempt', async () => {
    const { user, option, next } = setup();
    await user.click(next);
    expect(screen.getByRole('alert')).toBeInTheDocument();

    await user.click(option('approximate'));

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByText(copy.timeHint)).toBeInTheDocument();
  });

  it('keeps the typed time when switching between "exactly" and "roughly"', async () => {
    const { user, option } = setup('exact', { hours: '14', minutes: '30' });
    await user.click(option('approximate'));
    expect(screen.getByLabelText(copy.hours)).toHaveValue('14');
    expect(screen.getByLabelText(copy.minutes)).toHaveValue('30');
  });

  describe('with an answer the server rejected', () => {
    const TIME = 'Укажи время рождения в формате ЧЧ:ММ или отметь, что не знаешь';
    const PRECISION = 'Укажи, насколько точно известно время рождения';
    const typed: TimeParts = { hours: '14', minutes: '30' };
    const options = () => screen.getByRole('radiogroup', { name: copy.optionsLabel });

    it('shows the text about the time at the time field and puts the cursor into it', () => {
      setup('exact', typed, { timeError: TIME });

      expect(screen.getByRole('alert')).toHaveTextContent(TIME);
      const hours = screen.getByLabelText(copy.hours);
      expect(hours).toHaveAttribute('aria-invalid', 'true');
      expect(hours).toHaveFocus();
      expect(screen.getByRole('group', { name: copy.timeLabel })).toHaveAccessibleDescription(TIME);
      expect(options()).not.toHaveAccessibleDescription();
    });

    it('shows the text about the precision at the options and focuses the chosen one', () => {
      const { option } = setup('approximate', typed, { precisionError: PRECISION });

      expect(screen.getByRole('alert')).toHaveTextContent(PRECISION);
      expect(options()).toHaveAccessibleDescription(PRECISION);
      expect(option('approximate')).toHaveFocus();
      // The time itself was not rejected: its field keeps the hint.
      expect(screen.getByLabelText(copy.hours)).not.toHaveAttribute('aria-invalid');
      expect(screen.getByText(copy.timeHint)).toBeInTheDocument();
    });

    it('shows a text about the time next to the options when "I don\'t know" leaves no time field to show it at', () => {
      const { option } = setup('unknown', undefined, { timeError: TIME });

      expect(screen.getByRole('alert')).toHaveTextContent(TIME);
      expect(options()).toHaveAccessibleDescription(TIME);
      expect(option('unknown')).toHaveFocus();
    });

    it('shows both texts, each in its place', () => {
      setup('exact', typed, { precisionError: PRECISION, timeError: TIME });

      expect(screen.getAllByRole('alert').map((alert) => alert.textContent)).toEqual([PRECISION, TIME]);
      expect(options()).toHaveAccessibleDescription(PRECISION);
    });

    it('prefers its own text while the time on screen has a problem of its own', async () => {
      const { user, next } = setup('exact', typed, { timeError: TIME });

      await user.clear(screen.getByLabelText(copy.minutes));
      await user.click(next);

      expect(screen.getByRole('alert')).toHaveTextContent(copy.issues.incomplete);
      expect(screen.queryByText(TIME)).not.toBeInTheDocument();
    });

    it('lets the user go on unchanged: only the server can tell whether its verdict still stands', async () => {
      const { user, next, onNext } = setup('exact', typed, { timeError: TIME });
      await user.click(next);
      expect(onNext).toHaveBeenCalledTimes(1);
    });
  });
});
