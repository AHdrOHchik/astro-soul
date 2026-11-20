import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, type Question } from '../api';
import { fakeApi, fakeTelegram } from '../test/fixtures';
import { QuestionsScreen } from './QuestionsScreen';

const result = (overrides: Partial<Question> = {}): Question => ({ id: 'q-1', status: 'pending', question: 'Как мне распределить силы?', sections: [], chars: 0, warnings: [], topic: 'self', created_at: '2026-11-15T10:00:00Z', disclaimer: 'Дисклеймер сервера.', quota: { used: 1, limit: 3, resets_at: '2026-11-16T00:00:00Z' }, ...overrides });
function setup({ subscribed = true } = {}) {
  const api = fakeApi();
  const onSubscribe = vi.fn();
  const view = render(<QuestionsScreen api={api} telegram={fakeTelegram()} subscribed={subscribed} onSubscribe={onSubscribe} onChartGone={vi.fn()}/>);
  return { ...view, api, onSubscribe };
}
afterEach(() => vi.useRealTimers());

describe('QuestionsScreen', () => {
  it('presents examples before the subscription route for non-subscribers', async () => {
    const { api } = setup({ subscribed: false });
    expect(screen.getByText('Как лучше распределить силы на этой неделе?')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Посмотреть подписку' })).toBeInTheDocument();
    expect(await screen.findByText('Вопросы удаляются только вместе с аккаунтом.')).toBeInTheDocument();
    expect(api.createQuestion).not.toHaveBeenCalled();
  });
  it('shows the refused server message and does not poll again', async () => {
    const { api } = setup();
    api.createQuestion.mockResolvedValue({ id: 'q-refused', status: 'refused', quota: { used: 0, limit: 3, resets_at: '2026-11-16T00:00:00Z' } });
    api.getQuestion.mockResolvedValue(result({ id: 'q-refused', status: 'refused', message: 'Этот вопрос вне темы карты.' }));
    fireEvent.change(screen.getByLabelText('Напиши вопрос о своей карте'), { target: { value: 'Можно ли вылечить заболевание?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Спросить' }));
    expect(await screen.findByText('Этот вопрос вне темы карты.')).toBeInTheDocument();
    expect(api.getQuestion).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: 'Спросить другое' })).toBeInTheDocument();
  });
  it('shows subscription-required as a paywall route without exposing API details', async () => {
    const { api } = setup();
    api.createQuestion.mockRejectedValue(new ApiError('FORBIDDEN', { status: 403, details: { reason: 'subscription_required' } }));
    fireEvent.change(screen.getByLabelText('Напиши вопрос о своей карте'), { target: { value: 'Как мне распределить силы?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Спросить' }));
    expect(await screen.findByText('Для отправки вопроса нужна подписка.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Посмотреть подписку' })).toBeInTheDocument();
    expect(screen.queryByText(/subscription_required|FORBIDDEN/i)).not.toBeInTheDocument();
  });
  it('routes daily_cost_cap to support and does not retry the rejected submission', async () => {
    const { api } = setup();
    api.createQuestion.mockRejectedValue(new ApiError('RATE_LIMITED', { status: 429, details: { reason: 'daily_cost_cap' } }));
    fireEvent.change(screen.getByLabelText('Напиши вопрос о своей карте'), { target: { value: 'Как мне распределить силы?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Спросить' }));
    expect(await screen.findByText('Сейчас вопросы временно приостановлены. Напиши в поддержку.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Контакт поддержки ещё не задан' })).toBeDisabled();
    expect(screen.queryByText(/daily_cost_cap|429/i)).not.toBeInTheDocument();
    expect(api.createQuestion).toHaveBeenCalledOnce();
  });
  it('formats quota reset as absolute device-local time and does not say tomorrow', async () => {
    const { api } = setup();
    const error = new ApiError('FORBIDDEN', { status: 403, details: { reason: 'quota_exhausted', quota: { used: 3, limit: 3, resets_at: '2026-11-16T00:00:00Z' } } });
    api.createQuestion.mockRejectedValue(error);
    fireEvent.change(screen.getByLabelText('Напиши вопрос о своей карте'), { target: { value: 'Как мне распределить силы?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Спросить' }));
    expect(await screen.findByText(/Лимит вопросов исчерпан \(3 из 3\)\. Обновится:/)).toBeInTheDocument();
    expect(screen.queryByText(/завтра|через \d+ минут/i)).not.toBeInTheDocument();
  });
  it('loads and opens the pending item after question_in_progress, then polls it', async () => {
    vi.useFakeTimers();
    const pending = result();
    const { api } = setup();
    api.createQuestion.mockRejectedValue(new ApiError('CONFLICT', { status: 409, details: { reason: 'question_in_progress' } }));
    api.listQuestions.mockResolvedValue({ items: [pending], quota: pending.quota });
    api.getQuestion.mockResolvedValue(result({ status: 'ready', sections: [{ key: 'answer', title: 'Ответ', body: 'Текст ответа.' }], warnings: ['ungrounded'] }));
    fireEvent.change(screen.getByLabelText('Напиши вопрос о своей карте'), { target: { value: 'Как мне распределить силы?' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Спросить' })); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    expect(api.listQuestions).toHaveBeenCalledTimes(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(screen.getByText('Текст ответа.')).toBeInTheDocument();
    expect(screen.getByText('Ответ может быть менее точно связан с положениями карты.')).toBeInTheDocument();
    expect(screen.getByText('Дисклеймер сервера.')).toBeInTheDocument();
  });
  it('ignores unknown warnings rather than showing a technical code', async () => {
    const api = fakeApi();
    api.listQuestions.mockResolvedValue({ items: [result({ status: 'ready', sections: [{ key: 'answer', title: 'Ответ', body: 'Готовый ответ.' }], warnings: ['future_internal_code'] as unknown as Question['warnings'] })], quota: result().quota });
    render(<QuestionsScreen api={api} telegram={fakeTelegram()} subscribed onChartGone={vi.fn()}/>);
    expect(await screen.findByText('Как мне распределить силы?')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Как мне распределить силы/ }));
    expect(screen.getByText('Готовый ответ.')).toBeInTheDocument();
    expect(screen.queryByText('future_internal_code')).not.toBeInTheDocument();
  });
});
