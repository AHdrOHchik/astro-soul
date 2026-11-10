import { render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ru } from '../i18n/ru';
import type { DateParts } from '../lib/birth';
import { setupUser, TODAY } from '../test/fixtures';
import { BirthDateScreen } from './BirthDateScreen';

const copy = ru.birthDate;
const EMPTY: DateParts = { day: '', month: '', year: '' };

function setup(initial: DateParts = EMPTY) {
  const onNext = vi.fn();
  const user = setupUser();
  function Harness() {
    const [value, setValue] = useState(initial);
    return <BirthDateScreen value={value} today={TODAY} onChange={setValue} onNext={onNext} />;
  }
  render(<Harness />);
  return {
    user,
    onNext,
    day: screen.getByLabelText<HTMLInputElement>(copy.day),
    month: screen.getByLabelText<HTMLInputElement>(copy.month),
    year: screen.getByLabelText<HTMLInputElement>(copy.year),
    next: screen.getByRole('button', { name: ru.common.next }),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('BirthDateScreen', () => {
  it('takes a date typed as one run of digits and hands focus to the button', async () => {
    const { user, day, month, year, next, onNext } = setup();
    expect(day).toHaveFocus();

    await user.keyboard('17051994');

    expect([day.value, month.value, year.value]).toEqual(['17', '05', '1994']);
    expect(next).toHaveFocus();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    await user.click(next);
    expect(onNext).toHaveBeenCalledTimes(1);
  });

  it('does not pull focus away while a two-digit month is still being typed', async () => {
    const { user, month, next } = setup({ day: '17', month: '', year: '1994' });

    await user.click(month);
    await user.keyboard('1');
    // 17.1.1994 is a valid date already, but the user may be heading for 10, 11 or 12.
    expect(month).toHaveFocus();

    await user.keyboard('2');
    expect(month).toHaveValue('12');
    expect(next).toHaveFocus();
  });

  it('refuses a date under 18 and says why', async () => {
    const { user, next, year, onNext } = setup();

    await user.keyboard('11112008');

    expect(screen.getByRole('alert')).toHaveTextContent(copy.issues.underage);
    expect(year).toHaveAttribute('aria-invalid', 'true');
    expect(year).toHaveFocus();
    await user.click(next);
    expect(onNext).not.toHaveBeenCalled();
  });

  it('accepts the 18th birthday itself', async () => {
    const { user, next, onNext } = setup();
    await user.keyboard('10112008');
    await user.click(next);
    expect(onNext).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['31021994', copy.issues.invalid],
    ['17052030', copy.issues.future],
    ['17051899', copy.issues.too_old],
  ])('rejects %s', async (digits, message) => {
    const { user, next, onNext } = setup();
    await user.keyboard(digits);
    expect(screen.getByRole('alert')).toHaveTextContent(message);
    await user.click(next);
    expect(onNext).not.toHaveBeenCalled();
  });

  it('keeps quiet about an unfinished date until the user tries to continue', async () => {
    const { user, next, year, onNext } = setup();

    await user.keyboard('1705');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    await user.click(next);

    expect(screen.getByRole('alert')).toHaveTextContent(copy.issues.incomplete);
    expect(onNext).not.toHaveBeenCalled();
    expect(year).toHaveFocus();
  });

  it('submits with the Enter key of the keyboard', async () => {
    const { user, onNext, year } = setup({ day: '17', month: '05', year: '1994' });
    await user.click(year);
    await user.keyboard('{Enter}');
    expect(onNext).toHaveBeenCalledTimes(1);
  });

  it('names the screen and the step for assistive tech', () => {
    setup();
    expect(screen.getByRole('main', { name: copy.title })).toBeInTheDocument();
    expect(screen.getByText(ru.common.step(1, 3))).toBeInTheDocument();
  });
});
