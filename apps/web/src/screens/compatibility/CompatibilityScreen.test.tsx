import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import type { Compatibility } from '../../api';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiError, cataloguePlans, compatibilityPending, compatibilityReady, fakeApi, fakeAnalytics, fakeKeys, fakeTelegram, meSubscribed, rejection } from '../../test/fixtures';
import { ru } from '../../i18n/ru';
import { COMPATIBILITY_POLL_DELAYS_MS, CompatibilityScreen, stepItems } from './CompatibilityScreen';

const copy = ru.compatibility;
const chartId = '11111111-1111-4111-8111-111111111111';

afterEach(() => {
  vi.useRealTimers();
});

function mount(api = fakeApi(), initialId: string | null = null, telegram = fakeTelegram()) {
  const analytics = fakeAnalytics();
  const onBuy = vi.fn();
  const refreshMe = vi.fn(() => Promise.resolve(meSubscribed));
  function Harness() {
    const [compatibilityId, setCompatibilityId] = useState(initialId);
    return (
      <CompatibilityScreen
        api={api}
        chartId={chartId}
        compatibilityId={compatibilityId}
        onCompatibilityId={setCompatibilityId}
        keys={fakeKeys()}
        telegram={telegram}
        limits={{ geo_min_query_length: 2, geo_max_query_length: 40 }}
        refreshMe={refreshMe}
        supportLink="https://t.me/support"
        track={analytics.track}
        onBuy={onBuy}
      />
    );
  }
  const view = render(<Harness />);
  return { api, analytics, onBuy, refreshMe, telegram, ...view };
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

describe('stepItems', () => {
  it.each([
    ['2', '— Первый шаг.\n— Второй шаг.', ['Первый шаг.', 'Второй шаг.']],
    ['3', '1. Первый шаг.\n2. Второй шаг.\n3. Третий шаг.', ['Первый шаг.', 'Второй шаг.', 'Третий шаг.']],
    ['4', '• Первый шаг.\n• Второй шаг.\n• Третий шаг.\n• Четвёртый шаг.', ['Первый шаг.', 'Второй шаг.', 'Третий шаг.', 'Четвёртый шаг.']],
  ])('parses %s marked items', (_count, text, expected) => {
    expect(stepItems(text)).toEqual(expected);
  });

  it('leaves prose as prose when it has no list markers', () => {
    expect(stepItems('Поговорите о планах и договоритесь о следующем шаге.')).toEqual([]);
  });
});

describe('CompatibilityScreen', () => {
  it('sends only the specified partner fields and null birth_time when time is unknown', async () => {
    const user = userEvent.setup();
    const { api } = mount();
    expect(screen.getByText(copy.formPrivacy)).toBeInTheDocument();
    expect(copy.formPrivacy).toBe('Данные партнёра нужны только для расчёта. Мы не спрашиваем имя и не показываем его. Совместимость хранится вместе с остальными твоими данными и удаляется вместе с ними.');
    expect(screen.getByRole('textbox', { name: copy.place })).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: /имя|заметк/i })).not.toBeInTheDocument();
    const day = screen.getByLabelText(copy.dateSegments.day);
    await user.click(day);
    await user.keyboard('17051994');
    await user.click(screen.getByLabelText(copy.unknownTimeLabel));

    const placeField = screen.getByRole('textbox', { name: copy.place });
    await user.type(placeField, 'Ka');
    expect(await screen.findByRole('button', { name: /Казань/ })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Казань/ }));
    expect(screen.getByText(copy.unknownTime)).toBeInTheDocument();
    expect(copy.unknownTime).toContain('часть текста будет короче');
    expect(copy.unknownTime).not.toContain('примерно');
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

  it('does not submit without a selected city and places the required-field error by the city field', async () => {
    const user = userEvent.setup();
    const api = fakeApi();
    mount(api);
    await user.click(screen.getByLabelText(copy.dateSegments.day));
    await user.keyboard('17051994');
    await user.click(screen.getByLabelText(copy.timeSegments.hours));
    await user.keyboard('1230');
    await user.click(screen.getByRole('button', { name: copy.submit }));

    const city = screen.getByRole('textbox', { name: copy.place });
    expect(await screen.findByText(copy.missingPlace)).toBeInTheDocument();
    expect(city).toHaveAttribute('aria-invalid', 'true');
    expect(screen.queryByText(copy.formError)).not.toBeInTheDocument();
    expect(api.orderCompatibility).not.toHaveBeenCalled();
  });

  it('shows the server result in its order with server titles and does not add a PDF or a second disclaimer', async () => {
    const api = fakeApi();
    api.getCompatibility.mockResolvedValue(compatibilityReady);
    const { refreshMe } = mount(api, compatibilityReady.id);

    expect(await screen.findByRole('heading', { name: 'Что совпадает' })).toBeInTheDocument();
    await waitFor(() => {
      expect(api.getCompatibilities).toHaveBeenCalledTimes(2);
      expect(refreshMe).toHaveBeenCalledTimes(1);
    });
    expect(screen.getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent)).toEqual([
      'Что совпадает', 'Где трёт', 'Как вы разговариваете', 'Что сделать на этой неделе',
    ]);
    expect(screen.getByRole('heading', { level: 1, name: copy.title })).toBeInTheDocument();
    expect(screen.queryByText(/PDF/i)).not.toBeInTheDocument();
    expect(screen.getByText(/инструмент саморефлексии, а не предсказание и не замена специалисту/)).toBeInTheDocument();
    expect(document.body.textContent.match(/инструмент саморефлексии/g)).toHaveLength(1);
    expect(screen.getByRole('button', { name: copy.createAnother })).toBeEnabled();
  });

  it('shows only the trimmed warning from the closed allow-list', async () => {
    const withWarnings = {
      ...compatibilityReady,
      warnings: [
        { section: 'clicks', code: 'trimmed' },
        { section: 'friction', code: 'length_off' },
        { section: 'scenario', code: 'partner_pronoun' },
        { section: 'steps', code: 'gender_brackets' },
        { section: 'steps', code: 'teaser_terms' },
        { section: 'steps', code: 'disclaimer_added' },
        { section: 'steps', code: 'future_internal_code' },
      ],
    } as unknown as Compatibility;
    const api = fakeApi();
    api.getCompatibility.mockResolvedValue(withWarnings);
    mount(api, compatibilityReady.id);

    expect(await screen.findByText(copy.sectionTrimmed)).toBeInTheDocument();
    expect(screen.getAllByText(copy.sectionTrimmed)).toHaveLength(1);
    for (const hiddenCode of ['length_off', 'partner_pronoun', 'gender_brackets', 'teaser_terms', 'disclaimer_added', 'future_internal_code']) {
      expect(screen.queryByText(new RegExp(hiddenCode))).not.toBeInTheDocument();
    }
  });

  it('keeps the steps disclaimer in its own quiet paragraph exactly once', async () => {
    const duplicate = {
      ...compatibilityReady,
      sections: compatibilityReady.sections.map((section) => section.key === 'steps'
        ? { ...section, text: `— Первый шаг. ${copy.stepDisclaimer}\n— Второй шаг. ${copy.stepDisclaimer}` }
        : section),
    };
    const api = fakeApi();
    api.getCompatibility.mockResolvedValue(duplicate);
    mount(api, duplicate.id);

    await screen.findByRole('heading', { name: 'Что совпадает' });
    const notes = screen.getAllByText(copy.stepDisclaimer);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toHaveClass('disclaimer');
    expect(screen.getByRole('list').textContent).toContain('Первый шаг.');
    expect(screen.getByRole('list').textContent).toContain('Второй шаг.');
  });

  it('refreshes both compatibility quota and GET /me after a failed result', async () => {
    const failed = { ...compatibilityPending, status: 'failed' as const };
    const api = fakeApi();
    api.getCompatibility.mockResolvedValue(failed);
    const { refreshMe } = mount(api, failed.id);

    expect(await screen.findByText(copy.genericError)).toBeInTheDocument();
    await waitFor(() => {
      expect(api.getCompatibilities).toHaveBeenCalledTimes(2);
      expect(refreshMe).toHaveBeenCalledTimes(1);
    });
  });

  it('shares a fixed text without any partner data', async () => {
    const api = fakeApi();
    api.getCompatibility.mockResolvedValue(compatibilityReady);
    const telegram = fakeTelegram();
    const { analytics } = mount(api, compatibilityReady.id, telegram);
    await screen.findByRole('heading', { name: 'Что совпадает' });
    await userEvent.setup().click(screen.getByRole('button', { name: copy.share }));

    expect(copy.shareMessage).toBe('Мой разбор совместимости в Astro Soul');
    expect(copy.shareMessage).not.toMatch(/\d|Казань|романтическ|друг|родственник|коллег/i);
    expect(telegram.share).toHaveBeenCalledWith(window.location.origin, copy.shareMessage);
    expect(analytics.events).toContainEqual({ name: 'share_clicked' });
  });

  it('disables Create another at left zero and displays the server reset date', async () => {
    const api = fakeApi();
    api.getCompatibility.mockResolvedValue(compatibilityReady);
    api.getCompatibilities.mockResolvedValue({ items: [], quota: { kind: 'subscription', left: 0, resets_at: '2026-12-18T00:00:00Z' } });
    mount(api, compatibilityReady.id);
    await screen.findByRole('heading', { name: 'Что совпадает' });

    expect(await screen.findByText(/Осталось 0 из 1 · Обновится 18 декабря/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: copy.createAnother })).toBeDisabled();
  });

  it('enables Create another when the server says left one', async () => {
    const api = fakeApi();
    api.getCompatibility.mockResolvedValue(compatibilityReady);
    api.getCompatibilities.mockResolvedValue({ items: [], quota: { kind: 'subscription', left: 1, resets_at: '2026-12-18T00:00:00Z' } });
    mount(api, compatibilityReady.id);
    await screen.findByRole('heading', { name: 'Что совпадает' });

    await waitFor(() => { expect(screen.getByRole('button', { name: copy.createAnother })).toBeEnabled(); });
    expect(screen.queryByText(copy.quotaNext('18 декабря'))).not.toBeInTheDocument();
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
    const initialSignal = api.getCompatibility.mock.calls[0]?.[1];
    for (const [index, delay] of COMPATIBILITY_POLL_DELAYS_MS.entries()) {
      await act(async () => { await vi.advanceTimersByTimeAsync(delay); });
      expect(api.getCompatibility).toHaveBeenCalledTimes(index + 2);
    }
    view.unmount();
    expect(initialSignal?.aborted).toBe(true);
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
    await user.click(screen.getByRole('button', { name: copy.backToForm }));
    expect(screen.getByLabelText(copy.dateSegments.day)).toHaveValue('17');
    expect(screen.getByRole('textbox', { name: copy.place })).toHaveValue('Казань');
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
    expect(await screen.findByText(copy.alreadyOwned)).toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: copy.goTo }));

    expect(await screen.findByRole('heading', { name: copy.pendingTitle })).toBeInTheDocument();
    expect(api.getCompatibility).toHaveBeenCalledWith('22222222-2222-4222-8222-222222222222', expect.any(AbortSignal));
  });

  it('returns from already-owned to the form without losing the entered partner data', async () => {
    const api = fakeApi();
    api.orderCompatibility.mockRejectedValue(apiError('VALIDATION_FAILED', { status: 422, details: { reason: 'compat_already_owned' } }));
    const user = userEvent.setup();
    mount(api);
    await fillRequiredFields(user);
    await user.click(screen.getByRole('button', { name: copy.submit }));
    expect(await screen.findByText(copy.alreadyOwned)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: copy.backToForm }));
    expect(screen.getByLabelText(copy.dateSegments.day)).toHaveValue('17');
    expect(screen.getByRole('textbox', { name: copy.place })).toHaveValue('Казань');
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

  it('treats a 503 with an empty reason as generic, not as an open breaker', async () => {
    const api = fakeApi();
    api.orderCompatibility.mockRejectedValue(apiError('INTERNAL', { status: 503, details: {} }));
    const user = userEvent.setup();
    mount(api);
    await fillRequiredFields(user);
    await user.click(screen.getByRole('button', { name: copy.submit }));

    expect(await screen.findByText(copy.genericError)).toBeInTheDocument();
    expect(screen.queryByText(copy.breakerOpen)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Написать в поддержку' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: copy.retryAgain })).toBeEnabled();
  });

  it.each(['500', 'network'] as const)('retries a %s failure from the button using the same form data', async (failure) => {
    const api = fakeApi();
    api.orderCompatibility
      .mockRejectedValueOnce(failure === '500' ? apiError('INTERNAL', { status: 500 }) : new TypeError('Network unavailable'))
      .mockResolvedValueOnce({ compatibility_id: 'compatibility-retried', status: 'pending' });
    const user = userEvent.setup();
    mount(api);
    await fillRequiredFields(user);
    await user.click(screen.getByRole('button', { name: copy.submit }));

    expect(await screen.findByText(copy.genericError)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: copy.retryAgain }));
    expect(await screen.findByRole('heading', { name: copy.pendingTitle })).toBeInTheDocument();
    expect(api.orderCompatibility).toHaveBeenCalledTimes(2);
    expect(api.orderCompatibility.mock.calls[1]?.[0]).toEqual(api.orderCompatibility.mock.calls[0]?.[0]);
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
