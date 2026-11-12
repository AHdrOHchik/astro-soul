import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { CONSENT_VERSION, ru } from '../i18n/ru';
import { DocumentScreen } from './DocumentScreen';

const copy = ru.documents;

/** Everything the screen says under its title, paragraph by paragraph. */
const paragraphs = () =>
  within(screen.getByRole('main'))
    .getAllByText(/./, { selector: 'p' })
    .map((paragraph) => paragraph.textContent);

describe('DocumentScreen', () => {
  it('opens the policy under its own name: every paragraph in order, then the version', () => {
    render(<DocumentScreen name="privacy" />);

    expect(screen.getByRole('main', { name: ru.consent.documents.privacy })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: ru.consent.documents.privacy })).toHaveFocus();
    expect(paragraphs()).toEqual([...copy.privacy.paragraphs, copy.version(CONSENT_VERSION)]);
  });

  it('opens the agreement under its own name: every paragraph in order, then the version', () => {
    render(<DocumentScreen name="terms" />);

    expect(screen.getByRole('heading', { level: 1, name: ru.consent.documents.terms })).toHaveFocus();
    expect(paragraphs()).toEqual([...copy.terms.paragraphs, copy.version(CONSENT_VERSION)]);
  });

  it('has nothing to tick or confirm: it is there to be read', () => {
    render(<DocumentScreen name="privacy" />);
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('draws its own Back control when it is given one', async () => {
    const onClick = vi.fn();
    render(<DocumentScreen name="terms" back={{ label: ru.common.back, onClick }} />);
    await userEvent.click(screen.getByRole('button', { name: ru.common.back }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
