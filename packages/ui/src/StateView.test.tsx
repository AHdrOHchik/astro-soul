import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { StateView } from './StateView';

describe('StateView', () => {
  it('reads the title, the text and the note as one message, in that order, with the actions after it', () => {
    render(
      <StateView title="Заголовок" text="Текст." note="Мелкая строка.">
        <button type="button">Действие</button>
      </StateView>,
    );

    const message = screen.getByRole('status');
    expect([...message.querySelectorAll('h2, p')].map((line) => line.textContent)).toEqual(['Заголовок', 'Текст.', 'Мелкая строка.']);
    // The note is a part of what is announced, not of what is tapped.
    expect(message).not.toContainElement(screen.getByRole('button', { name: 'Действие' }));
    expect(message.compareDocumentPosition(screen.getByRole('button')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('the note is small print, the text is not', () => {
    render(<StateView title="Заголовок" text="Текст." note="Мелкая строка." />);

    // With the test setup of CSS modules a class is its own name in the stylesheet.
    expect(screen.getByText('Мелкая строка.')).toHaveClass('note');
    expect(screen.getByText('Текст.')).toHaveClass('text');
    expect(screen.getByText('Текст.')).not.toHaveClass('note');
  });

  it('leaves no empty line behind when there is no note, or no text', () => {
    const { rerender } = render(<StateView title="Заголовок" text="Текст." />);
    expect(screen.getByRole('status').querySelectorAll('p')).toHaveLength(1);

    rerender(<StateView title="Заголовок" />);
    expect(screen.getByRole('status').querySelectorAll('p')).toHaveLength(0);
  });

  it('an error is an alert, and may carry the note as well', () => {
    render(<StateView role="alert" title="Не получилось" text="Причина." note="Подробность." />);
    expect(screen.getByRole('alert')).toHaveTextContent('Не получилосьПричина.Подробность.');
  });
});
