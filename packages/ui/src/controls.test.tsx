import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createRef } from 'react';
import { describe, expect, it, vi } from 'vitest';
import {
  Button,
  ButtonLink,
  Checkbox,
  FieldMessage,
  Notice,
  OptionCard,
  Progress,
  Screen,
  ScreenHeading,
  SkeletonGroup,
  StateView,
} from './index';

describe('Screen', () => {
  it('renders the in-app back control only when asked to', async () => {
    const onClick = vi.fn();
    const { rerender } = render(<Screen>content</Screen>);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();

    rerender(<Screen back={{ label: 'Back', onClick }}>content</Screen>);
    await userEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('offers a way out of the screen in the top bar, with a back control or without one', async () => {
    const onBack = vi.fn();
    const onAction = vi.fn();
    const { rerender } = render(<Screen action={{ label: 'Settings', icon: <svg aria-hidden="true" />, onClick: onAction }}>content</Screen>);
    // The icon is decoration: the label alone names the control.
    await userEvent.click(screen.getByRole('button', { name: 'Settings' }));
    expect(onAction).toHaveBeenCalledOnce();

    rerender(
      <Screen back={{ label: 'Back', onClick: onBack }} action={{ label: 'Settings', onClick: onAction }}>
        content
      </Screen>,
    );
    const [first, second] = screen.getAllByRole('button');
    // Back comes first for the keyboard and a screen reader, the way out second.
    expect(first).toHaveAccessibleName('Back');
    expect(second).toHaveAccessibleName('Settings');
    expect(onBack).not.toHaveBeenCalled();
  });

  it('hands out its scrolling body, for a screen that puts its scroll position back', () => {
    const body = createRef<HTMLElement>();
    render(<Screen bodyRef={body}>content</Screen>);
    expect(body.current).toBe(screen.getByRole('main'));
  });
});

describe('Button', () => {
  it('is a plain button by default so it never submits a form by accident', () => {
    render(<Button>Go</Button>);
    expect(screen.getByRole('button', { name: 'Go' })).toHaveAttribute('type', 'button');
  });

  it('draws the action that cannot be undone its own way, and still tells a disabled one apart', () => {
    render(
      <>
        <Button variant="danger">Delete</Button>
        <Button variant="danger" disabled>
          Deleting
        </Button>
      </>,
    );
    expect(screen.getByRole('button', { name: 'Delete' })).toHaveClass('button', 'danger');
    expect(screen.getByRole('button', { name: 'Deleting' })).toBeDisabled();
  });
});

describe('ButtonLink', () => {
  it('is a real link, so the client follows the address itself', () => {
    render(
      <ButtonLink href="tg://settings/star_subscriptions" icon={<svg aria-hidden="true" />}>
        Open
      </ButtonLink>,
    );
    const link = screen.getByRole('link', { name: 'Open' });
    expect(link).toHaveAttribute('href', 'tg://settings/star_subscriptions');
    // Looks like a button, is not one: no `type`, no button role.
    expect(link).toHaveClass('button', 'secondary');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('passes on where and how the address opens', () => {
    render(
      <ButtonLink href="https://example.test/report.pdf" variant="primary" target="_blank" rel="noopener noreferrer" download>
        PDF
      </ButtonLink>,
    );
    const link = screen.getByRole('link', { name: 'PDF' });
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(link).toHaveAttribute('download');
    expect(link).toHaveClass('primary');
  });
});

describe('OptionCard', () => {
  it('is a real radio: the title names it, the description describes it', async () => {
    const onSelect = vi.fn();
    render(<OptionCard name="mode" value="exact" checked={false} onSelect={onSelect} title="Exact" description="To the minute" />);
    const radio = screen.getByRole('radio', { name: 'Exact' });
    expect(radio).toHaveAccessibleDescription('To the minute');
    await userEvent.click(radio);
    expect(onSelect).toHaveBeenCalledWith('exact');
  });

  it('reads out what stands aside after the title: a price belongs to the name of the choice', () => {
    render(
      <>
        <OptionCard name="plan" value="month" checked onSelect={vi.fn()} title="Month" description="Renews itself" aside={<span>399 stars</span>} />
        <OptionCard name="plan" value="year" checked={false} onSelect={vi.fn()} title="Year" />
      </>,
    );
    const month = screen.getByRole('radio', { name: 'Month 399 stars' });
    expect(month).toBeChecked();
    expect(month).toHaveAccessibleDescription('Renews itself');
    // Nothing aside: the title alone, as before.
    expect(screen.getByRole('radio', { name: 'Year' })).not.toBeChecked();
  });
});

describe('Progress', () => {
  it('is the native progress bar: named, out of 100, showing the value exactly as given', () => {
    const { rerender } = render(<Progress value={40} label="Report" />);
    const bar = screen.getByRole('progressbar', { name: 'Report' });
    expect(bar).toHaveAttribute('value', '40');
    expect(bar).toHaveAttribute('max', '100');

    rerender(<Progress value={0} label="Report" />);
    // Zero is a value, not «unknown»: the bar must not turn into the engine's endless animation.
    expect(bar).toHaveAttribute('value', '0');
  });
});

describe('Checkbox', () => {
  it('is a real checkbox named by its label, and reports a tap without ticking itself', async () => {
    const onChange = vi.fn();
    render(
      <Checkbox checked={false} onChange={onChange}>
        I agree
      </Checkbox>,
    );
    const box = screen.getByRole('checkbox', { name: 'I agree' });
    expect(box).not.toBeChecked();

    await userEvent.click(box);

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(true);
    // The caller owns the state: until it passes `checked`, the box stays empty.
    expect(box).not.toBeChecked();
  });

  it('toggles from a tap on the label text, and reports unticking', async () => {
    const onChange = vi.fn();
    render(
      <Checkbox checked onChange={onChange}>
        I agree
      </Checkbox>,
    );
    expect(screen.getByRole('checkbox')).toBeChecked();

    await userEvent.click(screen.getByText('I agree'));

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(false);
  });

  it('is reached and toggled from the keyboard', async () => {
    const onChange = vi.fn();
    render(
      <Checkbox checked={false} onChange={onChange}>
        I agree
      </Checkbox>,
    );

    await userEvent.tab();
    expect(screen.getByRole('checkbox')).toHaveFocus();
    await userEvent.keyboard(' ');

    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('carries the error state and its description to assistive tech', () => {
    render(
      <>
        <Checkbox checked={false} invalid describedBy="why" onChange={vi.fn()}>
          I agree
        </Checkbox>
        <p id="why">Consent is required</p>
      </>,
    );
    const box = screen.getByRole('checkbox');
    expect(box).toHaveAttribute('aria-invalid', 'true');
    expect(box).toHaveAccessibleDescription('Consent is required');
  });

  it('is neither invalid nor focused unless asked to be', () => {
    render(
      <Checkbox checked={false} onChange={vi.fn()}>
        I agree
      </Checkbox>,
    );
    expect(screen.getByRole('checkbox')).not.toHaveAttribute('aria-invalid');
    expect(screen.getByRole('checkbox')).not.toHaveFocus();
  });

  it('takes focus when the screen opens, if asked to', () => {
    render(
      <Checkbox checked={false} autoFocus onChange={vi.fn()}>
        I agree
      </Checkbox>,
    );
    expect(screen.getByRole('checkbox')).toHaveFocus();
  });
});

describe('states', () => {
  it('announces loading once for a group of skeletons', () => {
    render(<SkeletonGroup label="Loading">…</SkeletonGroup>);
    expect(screen.getByRole('status')).toHaveTextContent('Loading');
    expect(screen.getByRole('status')).toHaveAttribute('aria-busy', 'true');
  });

  it('announces errors as alerts and keeps actions outside the live region', () => {
    render(
      <StateView role="alert" title="Failed" text="Try again" caption="ref-1">
        <Button>Retry</Button>
      </StateView>,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('FailedTry again');
    expect(screen.getByRole('alert')).not.toContainElement(screen.getByRole('button', { name: 'Retry' }));
    expect(screen.getByText('ref-1')).toBeInTheDocument();
  });
});

describe('ScreenHeading', () => {
  it('takes focus when the screen opens, if asked to', () => {
    render(<ScreenHeading id="title" title="Title" focusOnMount />);
    expect(screen.getByRole('heading', { level: 1, name: 'Title' })).toHaveFocus();
  });

  it('takes focus without scrolling: a screen that opens where the user left it stays there', () => {
    const focus = vi.spyOn(HTMLElement.prototype, 'focus');
    render(<ScreenHeading id="title" title="Title" focusOnMount />);
    expect(focus).toHaveBeenCalledTimes(1);
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    focus.mockRestore();
  });

  it('does not steal focus when the prop turns on later', () => {
    const { rerender } = render(
      <>
        <ScreenHeading id="title" title="Title" />
        <button type="button">Action</button>
      </>,
    );
    screen.getByRole('button').focus();

    rerender(
      <>
        <ScreenHeading id="title" title="Title" focusOnMount />
        <button type="button">Action</button>
      </>,
    );

    expect(screen.getByRole('button')).toHaveFocus();
  });

  it('is described by the notice that says why the screen opened', () => {
    render(
      <>
        <ScreenHeading id="title" title="Title" describedBy="reason" focusOnMount />
        <Notice id="reason" tone="warning">
          Reason
        </Notice>
      </>,
    );
    const heading = screen.getByRole('heading', { level: 1, name: 'Title' });
    expect(heading).toHaveFocus();
    expect(heading).toHaveAccessibleDescription('Reason');
    expect(screen.getByRole('note')).toHaveTextContent('Reason');
  });
});

describe('StateView', () => {
  it('renders no empty action row when every conditional action is off', () => {
    const { container } = render(
      <StateView title="Title">
        {false}
        {null}
      </StateView>,
    );
    expect(container.querySelector('.actions')).toBeNull();
  });

  it('takes a control for its small print, outside the live region', async () => {
    const onCopy = vi.fn();
    const { container } = render(
      <StateView
        role="alert"
        title="Failed"
        caption={
          <button type="button" onClick={onCopy}>
            ref-1
          </button>
        }
      />,
    );
    const reference = screen.getByRole('button', { name: 'ref-1' });
    expect(screen.getByRole('alert')).not.toContainElement(reference);
    // A button may not sit in a paragraph: the small print is a block of its own.
    expect(container.querySelector('p button')).toBeNull();
    await userEvent.click(reference);
    expect(onCopy).toHaveBeenCalledOnce();
  });
});

describe('FieldMessage', () => {
  it('announces an error and falls back to the hint', () => {
    const { rerender } = render(<FieldMessage id="message" hint="Hint" />);
    expect(screen.getByText('Hint')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();

    rerender(<FieldMessage id="message" hint="Hint" error="Error" />);
    expect(screen.getByRole('alert')).toHaveTextContent('Error');
    expect(screen.queryByText('Hint')).not.toBeInTheDocument();
  });

  it('announces a hint that reports progress', () => {
    const { rerender } = render(<FieldMessage id="message" hint="Searching" live />);
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('Searching');

    rerender(<FieldMessage id="message" hint="Found 2" live />);
    // The same element, so that the change is what a screen reader hears.
    expect(screen.getByRole('status')).toBe(status);
    expect(status).toHaveTextContent('Found 2');
  });

  it('brings an error into view, and only an error', () => {
    const scrollIntoView = vi.spyOn(Element.prototype, 'scrollIntoView');
    const { rerender } = render(<FieldMessage id="message" hint="Hint" />);
    expect(scrollIntoView).not.toHaveBeenCalled();

    rerender(<FieldMessage id="message" hint="Hint" error="Error" />);
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });

    rerender(<FieldMessage id="message" hint="Hint" />);
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    scrollIntoView.mockRestore();
  });
});
