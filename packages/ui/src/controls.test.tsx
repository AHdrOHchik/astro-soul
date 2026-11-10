import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Button, FieldMessage, OptionCard, Screen, ScreenHeading, SkeletonGroup, StateView } from './index';

describe('Screen', () => {
  it('renders the in-app back control only when asked to', async () => {
    const onClick = vi.fn();
    const { rerender } = render(<Screen>content</Screen>);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();

    rerender(<Screen back={{ label: 'Back', onClick }}>content</Screen>);
    await userEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(onClick).toHaveBeenCalledOnce();
  });
});

describe('Button', () => {
  it('is a plain button by default so it never submits a form by accident', () => {
    render(<Button>Go</Button>);
    expect(screen.getByRole('button', { name: 'Go' })).toHaveAttribute('type', 'button');
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
