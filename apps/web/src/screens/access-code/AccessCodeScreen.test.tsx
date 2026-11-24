import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Me } from '../../api';
import { formatDayMonthOf } from '../../i18n/format';
import { ru } from '../../i18n/ru';
import { activatedAllAccess, activatedPending, apiError, entitlements, fakeAnalytics, fakeApi, setupUser } from '../../test/fixtures';
import { AccessCodeScreen, type AccessCodeScreenProps } from './AccessCodeScreen';

const copy = ru.accessCode;
const CODE = 'K7M2P9X4';

interface SetupOptions {
  api?: ReturnType<typeof fakeApi>;
  /** The rights the app knew before the code. */
  before?: Me['entitlements'];
  props?: Partial<AccessCodeScreenProps>;
}

function setup({ api = fakeApi(), before = entitlements, props }: SetupOptions = {}) {
  const analytics = fakeAnalytics();
  const refreshMe = vi.fn<NonNullable<AccessCodeScreenProps['refreshMe']>>().mockResolvedValue({} as Me);
  const onClose = vi.fn();
  const user = setupUser();
  const view = render(
    <AccessCodeScreen
      api={api}
      entitlements={before}
      refreshMe={refreshMe}
      track={analytics.track}
      onClose={onClose}
      {...props}
    />,
  );
  return { api, analytics, refreshMe, onClose, user, ...view };
}

const field = () => screen.getByLabelText(copy.field);
const submitButton = () => screen.getByRole('button', { name: copy.submit });

/** Types a code into the field the way a person would: one character at a time. */
async function type(user: ReturnType<typeof setupUser>, value: string) {
  await user.type(field(), value);
}

describe('AccessCodeScreen', () => {
  it('keeps the button inactive and sends nothing while the field is empty or short', async () => {
    const { api, user } = setup();

    expect(submitButton()).toBeDisabled();
    await type(user, 'K7M2P9X');
    expect(submitButton()).toBeDisabled();
    // Enter does not send a half-typed code either.
    await user.type(field(), '{Enter}');
    expect(api.activateCode).not.toHaveBeenCalled();
  });

  it('sends the normalized code, and nothing but the code, once eight characters are there', async () => {
    const { api, user } = setup();

    await type(user, 'k7m2-p9 x4');
    expect(field()).toHaveValue(CODE);
    expect(submitButton()).toBeEnabled();
    await user.click(submitButton());

    expect(api.activateCode).toHaveBeenCalledExactlyOnceWith(CODE);
  });

  it('does not send a complete value with a character the alphabet leaves out', async () => {
    const { api, user } = setup();

    // `0`, `O`, `1`, `I` are not guessed at: the button stays inactive and the field says why.
    await type(user, 'K7M2P9X0');
    expect(screen.getByText(copy.unknownCharacters)).toBeInTheDocument();
    expect(submitButton()).toBeDisabled();
    await user.click(submitButton());
    expect(api.activateCode).not.toHaveBeenCalled();
  });

  it('confirms a full access with its date, and asks Me again behind the confirmation', async () => {
    const { api, refreshMe, user } = setup();

    await type(user, CODE);
    await user.click(submitButton());

    expect(api.activateCode).toHaveBeenCalledExactlyOnceWith(CODE);
    expect(await screen.findByRole('heading', { name: copy.successTitle })).toBeInTheDocument();
    expect(screen.getByText(copy.success.allAccess(formatDayMonthOf(activatedAllAccess.all_access_until ?? '')))).toBeInTheDocument();
    expect(screen.getByText(/12 декабря/)).toBeInTheDocument();
    expect(refreshMe).toHaveBeenCalledTimes(1);
    // The code is not left in the field, not even behind the confirmation.
    expect(screen.queryByDisplayValue(CODE)).not.toBeInTheDocument();
  });

  it('says honestly that a code activated before the chart waits for it', async () => {
    const api = fakeApi();
    api.activateCode.mockResolvedValue(activatedPending);
    const { user } = setup({ api });

    await type(user, CODE);
    await user.click(submitButton());

    expect(await screen.findByText(copy.success.pending)).toBeInTheDocument();
    expect(screen.queryByText(/Полный доступ открыт до/)).not.toBeInTheDocument();
  });

  it('confirms one report and one compatibility in their own words', async () => {
    const api = fakeApi();
    api.activateCode.mockResolvedValueOnce({ ...entitlements, single_reports: 1 });
    const first = setup({ api });
    await type(first.user, CODE);
    await first.user.click(submitButton());
    expect(await screen.findByText(copy.success.singleReport)).toBeInTheDocument();
    first.unmount();

    api.activateCode.mockResolvedValueOnce({ ...entitlements, single_compat: 1 });
    const second = setup({ api });
    await type(second.user, CODE);
    await second.user.click(submitButton());
    expect(await screen.findByText(copy.success.singleCompat)).toBeInTheDocument();
  });

  it.each([
    ['no such code', apiError('NOT_FOUND', { status: 404, details: { reason: 'code_not_found' } }), copy.errors.not_found],
    ['code taken apart', apiError('CONFLICT', { status: 409, details: { reason: 'code_exhausted' } }), copy.errors.exhausted],
    ['code of one\'s own', apiError('CONFLICT', { status: 409, details: { reason: 'already_activated' } }), copy.errors.already_activated],
    ['expired code', apiError('GONE', { status: 410, details: { reason: 'code_expired' } }), copy.errors.expired],
    ['wrong format', apiError('VALIDATION_FAILED', { status: 422 }), copy.errors.invalid],
  ])('answers %s with its own words', async (_name, failure, text) => {
    const api = fakeApi();
    api.activateCode.mockRejectedValue(failure);
    const { user } = setup({ api });

    await type(user, CODE);
    await user.click(submitButton());

    expect(await screen.findByRole('alert')).toHaveTextContent(text);
  });

  it('names the minutes left when the attempts are limited', async () => {
    const api = fakeApi();
    api.activateCode.mockRejectedValue(apiError('RATE_LIMITED', { status: 429, details: { retry_after: 120 } }));
    const { user } = setup({ api });

    await type(user, CODE);
    await user.click(submitButton());

    expect(await screen.findByRole('alert')).toHaveTextContent(copy.errors.rateLimited(2, 'few'));
  });

  it('says it does not know how long the limit lasts when the server named no time', async () => {
    const api = fakeApi();
    api.activateCode.mockRejectedValue(apiError('RATE_LIMITED', { status: 429 }));
    const { user } = setup({ api });

    await type(user, CODE);
    await user.click(submitButton());

    expect(await screen.findByRole('alert')).toHaveTextContent(copy.errors.rateLimitedUnknown);
  });

  it('shows the session text for a 401 instead of words of its own about the code', async () => {
    const api = fakeApi();
    api.activateCode.mockRejectedValue(apiError('UNAUTHORIZED', { status: 401 }));
    const { user } = setup({ api });

    await type(user, CODE);
    await user.click(submitButton());

    expect(await screen.findByRole('alert')).toHaveTextContent(ru.errors.UNAUTHORIZED.text);
  });

  it('never puts the code, or a part of it, into a product event', async () => {
    const api = fakeApi();
    api.activateCode.mockRejectedValueOnce(apiError('CONFLICT', { status: 409, details: { reason: 'code_exhausted' } }));
    const { analytics, user } = setup({ api });

    await type(user, CODE);
    await user.click(submitButton());
    await screen.findByRole('alert');

    const sent = JSON.stringify(analytics.events);
    expect(analytics.events.length).toBeGreaterThan(0);
    expect(sent).not.toContain(CODE);
    for (let start = 0; start + 4 <= CODE.length; start += 1) {
      expect(sent).not.toContain(CODE.slice(start, start + 4));
    }
    // The failure is reported by its HTTP status, which is the only thing an event may say about it.
    expect(analytics.events).toContainEqual({ name: 'error_shown', props: { screen: 'access_code', code: '409' } });
  });

  it('leaves the screen by the confirmation button', async () => {
    const { onClose, user } = setup();

    await type(user, CODE);
    await user.click(submitButton());
    await user.click(await screen.findByRole('button', { name: copy.done }));

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('drops the refusal as soon as the code is edited', async () => {
    const api = fakeApi();
    api.activateCode.mockRejectedValueOnce(apiError('NOT_FOUND', { status: 404, details: { reason: 'code_not_found' } }));
    const { user } = setup({ api });

    await type(user, CODE);
    await user.click(submitButton());
    expect(await screen.findByRole('alert')).toHaveTextContent(copy.errors.not_found);

    await user.type(field(), '{Backspace}');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
