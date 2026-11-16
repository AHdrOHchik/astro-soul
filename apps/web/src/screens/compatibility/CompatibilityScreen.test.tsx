import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiError, cataloguePlans, compatibilityPending, compatibilityReady, fakeApi, fakeAnalytics, fakeKeys, fakeTelegram, rejection } from '../../test/fixtures';
import { ru } from '../../i18n/ru';
import { COMPATIBILITY_POLL_DELAYS_MS, CompatibilityScreen } from './CompatibilityScreen';

const copy = ru.compatibility;
const chartId = '11111111-1111-4111-8111-111111111111';

afterEach(() => {
  vi.useRealTimers();
});

function mount(api = fakeApi(), initialId: string | null = null) {
  const analytics = fakeAnalytics();
  const onBuy = vi.fn();
  function Harness() {
    const [compatibilityId, setCompatibilityId] = useState(initialId);
    return (
      <CompatibilityScreen
        api={api}
        chartId={chartId}
        compatibilityId={compatibilityId}
        onCompatibilityId={setCompatibilityId}
        keys={fakeKeys()}
        telegram={fakeTelegram()}
        limits={{ geo_min_query_length: 2, geo_max_query_length: 40 }}
        supportLink="https://t.me/support"
        track={analytics.track}
        onBuy={onBuy}
      />
    );
  }
  const view = render(<Harness />);
  return { api, analytics, onBuy, ...view };
}

async function fillRequiredFields(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByLabelText(copy.dateSegments.day));
  await user.keyboard('17051994');
  await user.click(screen.getByLabelText(copy.timeSegments.hours));
  await user.keyboard('1230');
  const placeField = screen.getByRole('textbox', { name: copy.place });
  await user.type(placeField, 'Ka');
  await user.click(await screen.findByRole('button', { name: /Казань/ }));
}

describe('CompatibilityScreen', () => {
  it('sends only the specified partner fields and null birth_time when time is unknown', async () => {
    const user = userEvent.setup();
    const { api } = mount();
    const day = screen.getByLabelText(copy.dateSegments.day);
    await user.click(day);
    await user.keyboard('17051994');
    await user.click(screen.getByLabelText(copy.unknownTimeLabel));

    const placeField = screen.getByRole('textbox', { name: copy.place });
    await user.type(placeField, 'Ka');
    expect(await screen.findByRole('button', { name: /Казань/ })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Казань/ }));
    expect(screen.getByText(copy.unknownTime)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: copy.submit }));

    await waitFor(() => { expect(api.orderCompatibility).toHaveBeenCalledOnce(); });
    const [request, key] = api.orderCompatibility.mock.calls[0] ?? [];
    expect(request).toEqual({
      chart_id: chartId,
      relationship: 'romantic',
      partner: { birth_date: '1994-05-17', birth_time: null, place: { lat: 55.7963, lon: 49.1088, tz: 'Europe/Moscow' } },
    });
    expect(Object.keys(request?.partner ?? {}).sort()).toEqual(['birth_date', 'birth_time', 'place']);
    expect(key).toMatch(/^key-/);
  });

  it('shows the server result in its order with server titles and does not add a PDF or a second disclaimer', async () => {
    const api = fakeApi();
    api.getCompatibility.mockResolvedValue(compatibilityReady);
    mount(api, compatibilityReady.id);

    expect(await screen.findByRole('heading', { name: 'Что совпадает' })).toBeInTheDocument();
    expect(screen.getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent)).toEqual([
      'Что совпадает', 'Где трёт', 'Как вы разговариваете', 'Что сделать на этой неделе',
    ]);
    expect(screen.getByRole('heading', { level: 1, name: copy.title })).toBeInTheDocument();
    expect(screen.queryByText(/PDF/i)).not.toBeInTheDocument();
    expect(screen.getByText(/инструмент саморефлексии, а не предсказание и не замена специалисту/)).toBeInTheDocument();
    expect(document.body.textContent.match(/инструмент саморефлексии/g)).toHaveLength(1);
    expect(screen.getByRole('button', { name: copy.createAnother })).toBeEnabled();
  });

  it('offers a non-blocking pending state and polls the request id', async () => {
    const api = fakeApi();
    api.orderCompatibility.mockResolvedValue({ compatibility_id: 'compatibility-1', status: 'pending' });
    mount(api);
    expect(screen.getByRole('heading', { name: copy.formTitle })).toBeInTheDocument();
    expect(screen.getByText(copy.formPrivacy)).toBeInTheDocument();
    await fillRequiredFields(userEvent.setup());

    const submit = screen.getByRole('button', { name: copy.submit });
    await userEvent.setup().click(submit);
    expect(await screen.findByRole('heading', { name: copy.pendingTitle })).toBeInTheDocument();
    await waitFor(() => { expect(api.getCompatibility).toHaveBeenCalledWith('compatibility-1', expect.any(AbortSignal)); });
    expect(screen.getByRole('status')).toHaveTextContent(copy.pendingText);
  });

  it('uses the contract polling backoff and cancels the timer on unmount', async () => {
    vi.useFakeTimers();
    const api = fakeApi();
    api.getCompatibility.mockResolvedValue({ ...compatibilityPending, id: 'compatibility-1' });
    const view = mount(api, 'compatibility-1');

    expect(api.getCompatibility).toHaveBeenCalledTimes(1);
    for (const [index, delay] of COMPATIBILITY_POLL_DELAYS_MS.entries()) {
      await act(async () => { await vi.advanceTimersByTimeAsync(delay); });
      expect(api.getCompatibility).toHaveBeenCalledTimes(index + 2);
    }
    view.unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(20000); });
    expect(api.getCompatibility).toHaveBeenCalledTimes(COMPATIBILITY_POLL_DELAYS_MS.length + 1);
  });

  it('shows 422 field errors at the corresponding form field', async () => {
    const api = fakeApi();
    api.orderCompatibility.mockRejectedValue(rejection({ field: 'partner.birth_date', message: 'Проверь дату.' }));
    const user = userEvent.setup();
    mount(api);
    await fillRequiredFields(user);
    await user.click(screen.getByRole('button', { name: copy.submit }));

    expect(await screen.findByText('Проверь дату.')).toBeInTheDocument();
    expect(screen.getByLabelText(copy.dateSegments.day)).toHaveAttribute('aria-invalid', 'true');
    expect(screen.queryByText(copy.formError)).not.toBeInTheDocument();
  });

  it('shows subscription quota exhaustion with the server reset date and a safe quota event', async () => {
    const api = fakeApi();
    api.orderCompatibility.mockRejectedValue(apiError('VALIDATION_FAILED', {
      status: 422,
      details: { reason: 'compat_quota_exhausted', resets_at: '2026-12-18T00:00:00Z', field_errors: [{ field: 'partner.relationship', message: 'Квота исчерпана.' }] },
    }));
    const user = userEvent.setup();
    const { analytics } = mount(api);
    await fillRequiredFields(user);
    await user.click(screen.getByRole('button', { name: copy.submit }));

    expect(await screen.findByText(copy.quotaExhausted('18 декабря'))).toBeInTheDocument();
    expect(analytics.events).toContainEqual({ name: 'quota_exhausted', props: { step: 'compatibility' } });
    const offer = cataloguePlans.find((plan) => plan.plan_code === 'compat_249');
    expect(offer).toBeDefined();
    if (offer) expect(screen.getByRole('button', { name: copy.buy(offer.stars) })).toBeEnabled();
  });

  it('directs compat_already_owned to the existing server item', async () => {
    const api = fakeApi();
    api.orderCompatibility.mockRejectedValue(apiError('VALIDATION_FAILED', { status: 422, details: { reason: 'compat_already_owned' } }));
    api.getCompatibilities.mockResolvedValue({
      items: [{ id: '22222222-2222-4222-8222-222222222222', status: 'pending', relationship: null, created_at: '2026-11-10T12:00:00Z', titles_only: [] }],
      quota: { kind: 'purchase', left: 1, resets_at: null },
    });
    api.getCompatibility.mockResolvedValue({ ...compatibilityPending, id: '22222222-2222-4222-8222-222222222222' });
    const user = userEvent.setup();
    mount(api);
    await fillRequiredFields(user);
    await user.click(screen.getByRole('button', { name: copy.submit }));
    await user.click(await screen.findByRole('button', { name: copy.goTo }));

    expect(await screen.findByRole('heading', { name: copy.pendingTitle })).toBeInTheDocument();
    expect(api.getCompatibility).toHaveBeenCalledWith('22222222-2222-4222-8222-222222222222', expect.any(AbortSignal));
  });

  it('keeps an unknown future server reason on the generic retry screen', async () => {
    const api = fakeApi();
    api.orderCompatibility.mockRejectedValue(apiError('INTERNAL', { status: 503, details: { reason: 'future_unknown_reason' } }));
    const user = userEvent.setup();
    mount(api);
    await fillRequiredFields(user);
    await user.click(screen.getByRole('button', { name: copy.submit }));

    expect(await screen.findByText(copy.genericError)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: copy.retryAgain })).toBeEnabled();
  });

  it('shows free retry for a breaker-open response and support', async () => {
    const api = fakeApi();
    api.orderCompatibility.mockRejectedValue(apiError('INTERNAL', { status: 503, details: { reason: 'compat_breaker_open' } }));
    const user = userEvent.setup();
    const { analytics } = mount(api);
    await fillRequiredFields(user);
    await user.click(screen.getByRole('button', { name: copy.submit }));

    expect(await screen.findByText(copy.breakerOpen)).toBeInTheDocument();
    expect(analytics.events).toContainEqual({ name: 'error_shown', props: { screen: 'compatibility', code: 'INTERNAL' } });
    expect(JSON.stringify(analytics.events)).not.toContain(chartId);
    expect(screen.getByRole('button', { name: copy.retryAgain })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Написать в поддержку' })).toBeEnabled();
  });
});
