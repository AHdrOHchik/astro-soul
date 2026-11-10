import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ru } from '../i18n/ru';
import { ConsentScreen, type ConsentScreenProps } from './ConsentScreen';
import { TOTAL_STEPS } from './StepScreen';

const copy = ru.consent;

function setup(props: Partial<ConsentScreenProps> = {}) {
  const onChange = vi.fn();
  const onOpenDocument = vi.fn();
  const onNext = vi.fn();
  render(<ConsentScreen accepted={false} onChange={onChange} onOpenDocument={onOpenDocument} onNext={onNext} {...props} />);
  return {
    onChange,
    onOpenDocument,
    onNext,
    user: userEvent.setup(),
    box: screen.getByRole('checkbox', { name: copy.checkbox }),
    proceed: screen.getByRole('button', { name: copy.submit }),
  };
}

describe('ConsentScreen', () => {
  it('shows the whole consent text: the title, the lead and every point', () => {
    setup();

    expect(screen.getByRole('main', { name: copy.title })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: copy.title })).toHaveFocus();
    expect(screen.getByText(copy.lead)).toBeInTheDocument();
    const points = within(screen.getAllByRole('list')[0] as HTMLElement).getAllByRole('listitem');
    expect(points.map((point) => point.textContent)).toEqual([...copy.points]);
  });

  it('is not one of the numbered steps: those are the birth data', () => {
    setup();
    for (let step = 1; step <= TOTAL_STEPS; step += 1) {
      expect(screen.queryByText(ru.common.step(step, TOTAL_STEPS))).not.toBeInTheDocument();
    }
  });

  it('keeps the way forward shut until the box is ticked', async () => {
    const { user, box, proceed, onNext } = setup();

    expect(box).not.toBeChecked();
    expect(proceed).toBeDisabled();
    await user.click(proceed);

    expect(onNext).not.toHaveBeenCalled();
  });

  it('reports the tap and leaves the tick to its caller: the box has no state of its own to be pre-ticked', async () => {
    const { user, box, proceed, onChange } = setup();

    await user.click(box);

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(true);
    expect(box).not.toBeChecked();
    expect(proceed).toBeDisabled();
  });

  it('goes on once the caller says the box is ticked, and reports unticking', async () => {
    const { user, box, proceed, onChange, onNext } = setup({ accepted: true });
    expect(box).toBeChecked();
    expect(proceed).toBeEnabled();

    await user.click(proceed);
    expect(onNext).toHaveBeenCalledTimes(1);

    await user.click(box);
    expect(onChange).toHaveBeenCalledWith(false);
  });

  it('offers both documents by name, and reading one neither ticks the box nor moves on', async () => {
    const { user, onOpenDocument, onChange, onNext } = setup();

    await user.click(screen.getByRole('button', { name: copy.documents.privacy }));
    await user.click(screen.getByRole('button', { name: copy.documents.terms }));

    expect(onOpenDocument.mock.calls).toEqual([['privacy'], ['terms']]);
    expect(onChange).not.toHaveBeenCalled();
    expect(onNext).not.toHaveBeenCalled();
  });

  it('shows no error and marks nothing invalid until the server rejects the consent', () => {
    const { box } = setup({ accepted: true });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(box).not.toHaveAttribute('aria-invalid');
    expect(box).not.toHaveAccessibleDescription();
  });

  it('shows what the server said about the consent at the box and brings focus to it', () => {
    const REJECTED = 'Без согласия на обработку данных мы не можем построить карту';
    const { box } = setup({ accepted: true, serverError: REJECTED });

    expect(screen.getByRole('alert')).toHaveTextContent(REJECTED);
    expect(box).toHaveAttribute('aria-invalid', 'true');
    expect(box).toHaveAccessibleDescription(REJECTED);
    expect(box).toHaveFocus();
  });

  it('draws its own Back control when it is given one', async () => {
    const onClick = vi.fn();
    const { user } = setup({ back: { label: ru.common.back, onClick } });
    await user.click(screen.getByRole('button', { name: ru.common.back }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
