import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { SegmentedInput, type Segment } from './SegmentedInput';

const DATE: Segment[] = [
  { id: 'day', label: 'day', placeholder: 'DD', length: 2, max: 31 },
  { id: 'month', label: 'month', placeholder: 'MM', length: 2, max: 12 },
  { id: 'year', label: 'year', placeholder: 'YYYY', length: 4 },
];

function setup(initial: Record<string, string> = {}) {
  const onChange = vi.fn();
  function Harness() {
    const [values, setValues] = useState(initial);
    return (
      <SegmentedInput
        segments={DATE}
        values={values}
        separator="."
        onChange={(next) => {
          onChange(next);
          setValues(next);
        }}
      />
    );
  }
  render(<Harness />);
  const field = (name: string) => screen.getByRole<HTMLInputElement>('textbox', { name });
  return { user: userEvent.setup(), onChange, day: field('day'), month: field('month'), year: field('year') };
}

describe('SegmentedInput', () => {
  it('moves to the next field when one is full', async () => {
    const { user, onChange, day, month, year } = setup();
    await user.click(day);
    await user.keyboard('17051994');
    expect([day.value, month.value, year.value]).toEqual(['17', '05', '1994']);
    expect(year).toHaveFocus();
    expect(onChange).toHaveBeenLastCalledWith({ day: '17', month: '05', year: '1994' });
  });

  it('accepts digits only', async () => {
    const { user, day } = setup();
    await user.type(day, 'a1-b');
    expect(day.value).toBe('1');
  });

  it('pads a digit that cannot start a valid number and moves on', async () => {
    const { user, day, month, year } = setup();
    await user.type(day, '4');
    expect(day.value).toBe('04');
    expect(month).toHaveFocus();
    await user.keyboard('7');
    expect(month.value).toBe('07');
    expect(year).toHaveFocus();
  });

  it('pads an unfinished two-digit field on blur, but never guesses a year', async () => {
    const { user, day, year } = setup();
    await user.type(day, '1');
    await user.click(year);
    expect(day.value).toBe('01');
    await user.keyboard('94');
    await user.click(day);
    expect(year.value).toBe('94');
  });

  it('spreads a pasted date over the fields, replacing what was there', async () => {
    const { user, day, month, year } = setup({ day: '1' });
    await user.click(day);
    await user.paste('17.05.1994');
    expect([day.value, month.value, year.value]).toEqual(['17', '05', '1994']);
    expect(year).toHaveFocus();
  });

  it('steps back with Backspace from an empty field', async () => {
    const { user, day, month } = setup({ day: '17' });
    await user.click(month);
    await user.keyboard('{Backspace}');
    expect(day).toHaveFocus();
  });
});
