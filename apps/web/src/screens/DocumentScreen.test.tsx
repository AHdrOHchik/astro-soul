import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ru } from '../i18n/ru';
import { DocumentScreen } from './DocumentScreen';

const copy = ru.documents;

describe('DocumentScreen', () => {
  it('opens the policy under its own name: what is collected, why and for how long, row by row', () => {
    render(<DocumentScreen name="privacy" />);

    expect(screen.getByRole('main', { name: ru.consent.documents.privacy })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: ru.consent.documents.privacy })).toHaveFocus();

    const { caption, columns, rows, notCollected } = copy.privacy;
    const section = within(screen.getByRole('region', { name: caption }));
    expect(section.getByRole('heading', { level: 2, name: caption })).toBeInTheDocument();
    // One block per row of the table, and in each the name of every column beside its value.
    const records = section.getAllByRole('listitem');
    expect(records.map((record) => within(record).getAllByRole('term').map((term) => term.textContent))).toEqual(
      rows.map(() => [...columns]),
    );
    expect(records.map((record) => within(record).getAllByRole('definition').map((value) => value.textContent))).toEqual(
      rows.map((row) => [...row]),
    );
    expect(screen.getByText(notCollected)).toBeInTheDocument();
  });

  it('opens the agreement under its own name with the disclaimer', () => {
    render(<DocumentScreen name="terms" />);

    expect(screen.getByRole('heading', { level: 1, name: ru.consent.documents.terms })).toHaveFocus();
    expect(screen.getByText(copy.terms.disclaimer)).toBeInTheDocument();
    expect(screen.queryByText(copy.privacy.caption)).not.toBeInTheDocument();
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
