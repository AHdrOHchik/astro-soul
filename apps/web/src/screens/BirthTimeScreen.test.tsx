import { render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ru } from '../i18n/ru';
import type { TimeMode, TimeParts } from '../lib/birth';
import { setupUser } from '../test/fixtures';
import { BirthTimeScreen } from './BirthTimeScreen';

const copy = ru.birthTime;

function setup(initialMode: TimeMode | null = null, initialTime: TimeParts = { hours: '', minutes: '' }) {
  const onNext = vi.fn();
  const user = setupUser();
  function Harness() {
    const [mode, setMode] = useState(initialMode);
    const [time, setTime] = useState(initialTime);
    return <BirthTimeScreen mode={mode} time={time} onModeChange={setMode} onTimeChange={setTime} onNext={onNext} />;
  }
  render(<Harness />);
  const option = (mode: TimeMode) => screen.getByRole('radio', { name: copy.options[mode].title });
  return { user, onNext, option, next: screen.getByRole('button', { name: ru.common.next }) };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('BirthTimeScreen', () => {
  it('offers exactly three options and preselects none', () => {
    const { option } = setup();
    expect(screen.getAllByRole('radio')).toHaveLength(3);
    for (const mode of ['exact', 'approx', 'unknown'] as const) expect(option(mode)).not.toBeChecked();
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

    await user.click(option('approx'));

    expect(screen.getByRole('note')).toHaveTextContent(copy.options.approx.accuracy);
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

    await user.click(option('approx'));
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

    await user.click(option('approx'));

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByText(copy.timeHint)).toBeInTheDocument();
  });

  it('keeps the typed time when switching between "exactly" and "roughly"', async () => {
    const { user, option } = setup('exact', { hours: '14', minutes: '30' });
    await user.click(option('approx'));
    expect(screen.getByLabelText(copy.hours)).toHaveValue('14');
    expect(screen.getByLabelText(copy.minutes)).toHaveValue('30');
  });
});
