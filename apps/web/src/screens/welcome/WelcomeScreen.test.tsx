import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ru } from '../../i18n/ru';
import { WelcomeScreen } from './WelcomeScreen';

const copy = ru.welcome;
/** The small print under the button, as one sentence. */
const TERMS_LINE = `${copy.terms.before}${copy.terms.link}${copy.terms.after}`;

function setup(returning = false) {
  const onStart = vi.fn();
  const onOpenTerms = vi.fn();
  render(<WelcomeScreen returning={returning} onStart={onStart} onOpenTerms={onOpenTerms} />);
  return {
    onStart,
    onOpenTerms,
    user: userEvent.setup(),
    start: screen.getByRole('button', { name: copy.start }),
    terms: screen.getByRole('button', { name: TERMS_LINE }),
  };
}

describe('WelcomeScreen', () => {
  it('keeps the disclaimer, the button and the way to the agreement out of the scrolling part, in that order', () => {
    const { start, terms } = setup();
    const disclaimer = screen.getByText(copy.disclaimer);
    const main = screen.getByRole('main');

    // The body scrolls, the footer does not: what is outside `main` is on screen at any height.
    for (const element of [disclaimer, start, terms]) expect(main).not.toContainElement(element);
    expect(disclaimer.compareDocumentPosition(start) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(start.compareDocumentPosition(terms) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('opens the agreement from the small print: the whole sentence is the control, the link words are marked in it', async () => {
    const { user, terms, onStart, onOpenTerms } = setup();

    expect(terms).toHaveTextContent(TERMS_LINE);
    expect(within(terms).getByText(copy.terms.link)).toBeInTheDocument();
    await user.click(terms);

    expect(onOpenTerms).toHaveBeenCalledTimes(1);
    expect(onStart).not.toHaveBeenCalled();
  });
});
