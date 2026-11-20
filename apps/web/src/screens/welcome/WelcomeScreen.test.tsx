import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ru } from '../../i18n/ru';
import { apiError, cataloguePlans, deferred, fakeApi } from '../../test/fixtures';
import { REPORT_PLAN } from '../../lib/plans';
import { WelcomeScreen } from './WelcomeScreen';

const copy = ru.welcome;
/** The small print under the button, as one sentence. */
const TERMS_LINE = `${copy.terms.before}${copy.terms.link}${copy.terms.after}`;

function setup(api = fakeApi()) {
  const onStart = vi.fn();
  const onOpenTerms = vi.fn();
  render(<WelcomeScreen api={api} onStart={onStart} onOpenTerms={onOpenTerms} onOpenSettings={vi.fn()} />);
  return {
    onStart,
    onOpenTerms,
    user: userEvent.setup(),
    start: screen.getByRole('button', { name: copy.start }),
    terms: screen.getByRole('button', { name: TERMS_LINE }),
  };
}

describe('WelcomeScreen', () => {
  it('does not gate Start on a pending catalogue and displays the returned report price', async () => {
    const api = fakeApi();
    const pending = deferred<typeof cataloguePlans>();
    api.getPlans.mockReturnValue(pending.promise);
    const { start, user, onStart } = setup(api);
    expect(screen.getByText(copy.freeChart)).toBeInTheDocument();
    expect(screen.queryByText(copy.fullReport, { exact: false })).toBeNull();
    await user.click(start);
    expect(onStart).toHaveBeenCalledOnce();
    const report = cataloguePlans.find((plan) => plan.plan_code === REPORT_PLAN);
    if (!report) throw new Error('Report missing from test catalogue');
    await act(async () => { pending.resolve([{ ...report, stars: report.stars + 7 }]); await pending.promise; });
    expect(screen.getByText(copy.fullReport, { exact: false })).toHaveTextContent(String(report.stars + 7));
  });

  it.each(['missing', 'offline'])('keeps the price absent for a %s catalogue', async (mode) => {
    const api = fakeApi();
    if (mode === 'missing') api.getPlans.mockResolvedValue(cataloguePlans.map((plan) => ({ ...plan, test: true })));
    else api.getPlans.mockRejectedValue(apiError('NETWORK'));
    const { start } = setup(api);
    await act(async () => { await Promise.resolve(); });
    expect(start).toBeEnabled();
    expect(screen.queryByText(copy.fullReport, { exact: false })).toBeNull();
  });

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
