import { fireEvent, render, screen } from '@testing-library/react';
import { createRef } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { TextArea } from './index';

describe('TextArea', () => {
  it('is named by its label and hands every change over as a string', () => {
    const onChange = vi.fn();
    render(<TextArea label="Question" value="" onChange={onChange} />);

    const field = screen.getByRole('textbox', { name: 'Question' });
    expect(field.tagName).toBe('TEXTAREA');
    fireEvent.change(field, { target: { value: 'Why?' } });
    expect(onChange).toHaveBeenCalledExactlyOnceWith('Why?');
  });

  it('passes the limits and the description on to the field, and gives out the field itself', () => {
    const ref = createRef<HTMLTextAreaElement>();
    render(<TextArea ref={ref} label="Question" value="abc" onChange={vi.fn()} maxLength={500} aria-describedby="hint" rows={3} />);

    const field = screen.getByRole('textbox', { name: 'Question' });
    expect(field).toHaveValue('abc');
    expect(field).toHaveAttribute('maxlength', '500');
    expect(field).toHaveAttribute('aria-describedby', 'hint');
    expect(field).toHaveAttribute('rows', '3');
    expect(ref.current).toBe(field);
  });
});
