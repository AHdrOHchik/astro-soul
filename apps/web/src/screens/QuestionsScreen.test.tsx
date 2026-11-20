import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, type Question } from '../api';
import { copy30 } from '../i18n/round30';
import { fakeApi, fakeTelegram } from '../test/fixtures';
import { QuestionsScreen, type QuestionsHistoryCache } from './QuestionsScreen';

const result = (overrides: Partial<Question> = {}): Question => ({ id: 'q-1', status: 'pending', question: 'Как мне распределить силы?', sections: [], chars: 0, warnings: [], topic: 'self', created_at: '2026-11-15T10:00:00Z', disclaimer: 'Дисклеймер сервера.', quota: { used: 1, limit: 3, resets_at: '2026-11-16T00:00:00Z' }, ...overrides });
function setup({ subscribed = true, api = fakeApi() }: { subscribed?: boolean; api?: ReturnType<typeof fakeApi> } = {}) {
  const onSubscribe = vi.fn();
  const onChartGone = vi.fn();
  const view = render(<QuestionsScreen api={api} telegram={fakeTelegram()} subscribed={subscribed} onSubscribe={onSubscribe} onChartGone={onChartGone}/>);
  return { ...view, api, onSubscribe, onChartGone };
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

describe('QuestionsScreen', () => {
  it('enforces the ten-character minimum before enabling submission', () => {
    setup();
    const field = screen.getByLabelText('Напиши вопрос о своей карте');
    const button = screen.getByRole('button', { name: 'Спросить' });
    expect(button).toBeDisabled();
    fireEvent.change(field, { target: { value: '123456789' } });
    expect(button).toBeDisabled();
    fireEvent.change(field, { target: { value: '1234567890' } });
    expect(button).toBeEnabled();
  });
  it('sets the 300-character input ceiling and reports the live count', () => {
    setup();
    const field = screen.getByLabelText('Напиши вопрос о своей карте');
    expect(field).toHaveAttribute('maxlength', '300');
    fireEvent.change(field, { target: { value: 'x'.repeat(300) } });
    expect(screen.getByText('300/300')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Спросить' })).toBeEnabled();
  });
  it('reuses the same idempotency key only after the user explicitly retries a failed POST', async () => {
    const { api } = setup();
    api.createQuestion.mockRejectedValueOnce(new ApiError('NETWORK')).mockResolvedValueOnce({ id: 'q-retry', status: 'pending', quota: { used: 1, limit: 3, resets_at: '2026-11-16T00:00:00Z' } });
    fireEvent.change(screen.getByLabelText('Напиши вопрос о своей карте'), { target: { value: 'Как мне распределить силы?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Спросить' }));
    await screen.findByRole('button', { name: 'Повторить' });
    expect(api.createQuestion).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'Повторить' }));
    await screen.findByText('Твой вопрос');
    expect(api.createQuestion).toHaveBeenCalledTimes(2);
    expect(api.createQuestion.mock.calls[0]?.[1]).toBe(api.createQuestion.mock.calls[1]?.[1]);
  });
  it('requests at most twenty history entries and has no per-question delete action', async () => {
    const { api } = setup();
    await screen.findByText('Вопросы удаляются только вместе с аккаунтом.');
    expect(api.listQuestions).toHaveBeenCalledWith(20, 0, expect.any(AbortSignal));
    expect(screen.queryByRole('button', { name: /удалить вопрос/i })).not.toBeInTheDocument();
    expect(screen.getByText('Вопросы удаляются только вместе с аккаунтом.')).toBeInTheDocument();
  });
  it('passes the question request signal and aborts an in-flight submit when leaving the screen', () => {
    const { api, unmount } = setup();
    api.createQuestion.mockReturnValue(new Promise(() => {}));
    fireEvent.change(screen.getByLabelText('Напиши вопрос о своей карте'), { target: { value: 'Как мне распределить силы?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Спросить' }));
    const signal = api.createQuestion.mock.calls[0]?.[2];
    expect(signal).toBeInstanceOf(AbortSignal);
    unmount();
    expect(signal?.aborted).toBe(true);
  });
  it('presents examples before the subscription route for non-subscribers', async () => {
    const { api } = setup({ subscribed: false });
    expect(screen.getByText('Как лучше распределить силы на этой неделе?')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Как лучше распределить силы на этой неделе?' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Посмотреть подписку' })).toBeInTheDocument();
    expect(await screen.findByText('Вопросы удаляются только вместе с аккаунтом.')).toBeInTheDocument();
    expect(api.createQuestion).not.toHaveBeenCalled();
  });
  it('uses examples as buttons only for subscribers, and selecting one fills the field without sending', () => {
    const { api } = setup();
    const example = 'Как лучше распределить силы на этой неделе?';
    fireEvent.click(screen.getByRole('button', { name: example }));
    expect(screen.getByLabelText('Напиши вопрос о своей карте')).toHaveValue(example);
    expect(api.createQuestion).not.toHaveBeenCalled();
  });

  it('does not load question history or submit without a chart', () => {
    const api = fakeApi();
    render(<QuestionsScreen api={api} telegram={fakeTelegram()} subscribed={false} chartAvailable={false} onChartGone={vi.fn()}/>);
    expect(screen.getByText('Сначала построй карту, чтобы задать вопрос.')).toBeInTheDocument();
    expect(api.listQuestions).not.toHaveBeenCalled();
    expect(api.createQuestion).not.toHaveBeenCalled();
  });
  it('formats the UTC reset instant as 03:00 in the phone timezone', async () => {
    vi.stubEnv('TZ', 'Europe/Amsterdam');
    const { api } = setup();
    api.createQuestion.mockRejectedValue(new ApiError('FORBIDDEN', { status: 403, details: { reason: 'quota_exhausted', quota: { used: 3, limit: 3, resets_at: '2026-11-16T02:00:00Z' } } }));
    fireEvent.change(screen.getByLabelText('Напиши вопрос о своей карте'), { target: { value: 'Как мне распределить силы?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Спросить' }));
    expect(await screen.findByText(/03:00/)).toBeInTheDocument();
    expect(screen.queryByText(/завтра/i)).not.toBeInTheDocument();
  });
  it('does not consume quota on refusal and lets the user start another question', async () => {
    const { api } = setup();
    api.createQuestion.mockResolvedValue({ id: 'q-refused', status: 'refused', quota: { used: 0, limit: 3, resets_at: '2026-11-16T00:00:00Z' } });
    api.getQuestion.mockResolvedValue(result({ id: 'q-refused', status: 'refused', message: 'Отказ дословно.', quota: { used: 0, limit: 3, resets_at: '2026-11-16T00:00:00Z' } }));
    fireEvent.change(screen.getByLabelText('Напиши вопрос о своей карте'), { target: { value: 'Можно ли вылечить заболевание?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Спросить' }));
    expect(await screen.findAllByText('Отказ дословно.')).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Спросить другое' })).toBeInTheDocument();
    expect(screen.queryByText(/Лимит вопросов исчерпан/)).not.toBeInTheDocument();
    expect(api.createQuestion).toHaveBeenCalledOnce();
    expect(api.getQuestion).toHaveBeenCalledOnce();
  });
  it('handles a deleted chart as a chart-gone transition, not as a question error', async () => {
    const { api, onChartGone } = setup();
    api.createQuestion.mockRejectedValue(new ApiError('NOT_FOUND', { status: 404 }));
    fireEvent.change(screen.getByLabelText('Напиши вопрос о своей карте'), { target: { value: 'Как мне распределить силы?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Спросить' }));
    await waitFor(() => { expect(onChartGone).toHaveBeenCalledOnce(); });
    expect(api.createQuestion).toHaveBeenCalledOnce();
    expect(screen.queryByText(/NOT_FOUND|404|Не удалось отправить вопрос/)).not.toBeInTheDocument();
  });
  it('keeps history failure separate: retry reloads only GET, preserving the question draft without a POST', async () => {
    const api = fakeApi();
    api.listQuestions.mockRejectedValueOnce(new ApiError('INTERNAL', { status: 500, serverMessage: 'internal detail' })).mockResolvedValue({ items: [], quota: { used: 1, limit: 3, resets_at: '2026-11-16T00:00:00Z' } });
    render(<QuestionsScreen api={api} telegram={fakeTelegram()} subscribed onChartGone={vi.fn()}/>);
    expect(await screen.findByText('Не удалось загрузить историю вопросов.')).toBeInTheDocument();
    expect(screen.queryByText(/internal detail|INTERNAL|500/)).not.toBeInTheDocument();
    const field = screen.getByRole('textbox', { name: 'Напиши вопрос о своей карте' });
    fireEvent.change(field, { target: { value: 'Как мне распределить силы?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Повторить' }));
    await screen.findByText('Вопросов пока нет.');
    expect(field).toHaveValue('Как мне распределить силы?');
    expect(api.listQuestions).toHaveBeenCalledTimes(2);
    expect(api.createQuestion).not.toHaveBeenCalled();
  });
  it('shows the refused server message and does not poll again', async () => {
    const { api } = setup();
    api.createQuestion.mockResolvedValue({ id: 'q-refused', status: 'refused', quota: { used: 0, limit: 3, resets_at: '2026-11-16T00:00:00Z' } });
    api.getQuestion.mockResolvedValue(result({ id: 'q-refused', status: 'refused', message: 'Этот вопрос вне темы карты.' }));
    fireEvent.change(screen.getByLabelText('Напиши вопрос о своей карте'), { target: { value: 'Можно ли вылечить заболевание?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Спросить' }));
    expect(await screen.findAllByText('Этот вопрос вне темы карты.')).toHaveLength(2);
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
  it('stops polling after three minutes and leaves the question in history', async () => {
    vi.useFakeTimers();
    const pending = result({ id: 'q-pending', status: 'pending' });
    const { api } = setup();
    api.createQuestion.mockRejectedValue(new ApiError('CONFLICT', { status: 409, details: { reason: 'question_in_progress' } }));
    api.listQuestions.mockResolvedValue({ items: [pending], quota: pending.quota });
    api.getQuestion.mockResolvedValue(pending);
    fireEvent.change(screen.getByLabelText('Напиши вопрос о своей карте'), { target: { value: 'Как мне распределить силы?' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Спросить' })); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(210_000); });
    expect(screen.getByText('Ответ пока готовится. Он появится в истории вопросов.')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'История' })).toBeInTheDocument();
    expect(screen.queryByText(/CONFLICT|question_in_progress/)).not.toBeInTheDocument();
  });
  it('silently filters failed rows from a legacy three-question list without logging', async () => {
    const api = fakeApi();
    const failed = result({ id: 'failed-q', question: 'Неудачный текст вопроса', status: 'failed' });
    const ready = result({ id: 'ready-q', status: 'ready' });
    const refused = result({ id: 'refused-q', status: 'refused', message: 'Отказ по теме.' });
    api.listQuestions.mockResolvedValue({ items: [ready, failed, refused], quota: ready.quota });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(<QuestionsScreen api={api} telegram={fakeTelegram()} subscribed onChartGone={vi.fn()}/>);
    expect(await screen.findByRole('heading', { name: 'История' })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /15 нояб/ })).toHaveLength(2);
    expect(screen.queryByText('Неудачный текст вопроса')).not.toBeInTheDocument();
    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it('shows refused questions as ordinary history entries with their answer, distinct from failure', async () => {
    const api = fakeApi();
    const refused = result({ status: 'refused', message: 'Этот вопрос вне темы карты.' });
    api.listQuestions.mockResolvedValue({ items: [refused], quota: refused.quota });
    render(<QuestionsScreen api={api} telegram={fakeTelegram()} subscribed onChartGone={vi.fn()}/>);
    const entry = await screen.findByRole('button', { name: /Как мне распределить силы/ });
    expect(entry).toHaveTextContent('Этот вопрос вне темы карты.');
    fireEvent.click(entry);
    expect(screen.getAllByText('Этот вопрос вне темы карты.')).toHaveLength(2);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByText(/не удалось|попробуй позже/i)).not.toBeInTheDocument();
  });

  it('shows a failed GET-by-id result, refreshes quota without consuming it, and retries as a new question', async () => {
    const api = fakeApi();
    const pending = result({ id: 'old-question', status: 'pending' });
    const failed = result({ id: 'old-question', status: 'failed' });
    api.listQuestions.mockResolvedValueOnce({ items: [pending], quota: { ...pending.quota, used: 1 } }).mockResolvedValueOnce({ items: [], quota: { ...pending.quota, used: 1 } });
    api.getQuestion.mockResolvedValue(failed);
    setup({ api });
    await screen.findByRole('button', { name: /Как мне распределить силы/ });
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole('button', { name: /Как мне распределить силы/ }));
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(screen.getByText('Этот вопрос не удался. Квота не списана.')).toBeInTheDocument();
    expect(screen.getByText('Использовано вопросов: 1 из 3.')).toBeInTheDocument();
    expect(api.listQuestions).toHaveBeenCalledTimes(2);
    expect(api.createQuestion).not.toHaveBeenCalled();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Спросить снова' })); await Promise.resolve(); await Promise.resolve(); });
    expect(api.createQuestion).toHaveBeenCalledOnce();
    expect(api.createQuestion.mock.calls[0]?.[0]).toBe(pending.question);
  });

  it('loads 20-item history pages at the loaded-item offset, keeps prior rows on error, and retries that page', async () => {
    const api = fakeApi();
    const first = Array.from({ length: 20 }, (_, index) => result({ id: `q-${String(index)}`, question: `Вопрос номер ${String(index)}` }));
    const last = result({ id: 'q-last', question: 'Последний вопрос страницы' });
    api.listQuestions.mockResolvedValueOnce({ items: first, total: 21, limit: 20, offset: 0, quota: result().quota })
      .mockRejectedValueOnce(new ApiError('NETWORK'))
      .mockResolvedValueOnce({ items: [last], total: 21, limit: 20, offset: 20, quota: last.quota });
    render(<QuestionsScreen api={api} telegram={fakeTelegram()} subscribed onChartGone={vi.fn()}/>);

    expect(await screen.findByText(copy30.questions.historyCount(21))).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: copy30.questions.loadMore }));
    expect(await screen.findByText(copy30.questions.loadMoreError)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Вопрос номер 0/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: copy30.questions.retryButton }));
    expect(await screen.findByRole('button', { name: /Последний вопрос страницы/ })).toBeInTheDocument();
    expect(api.listQuestions.mock.calls.map(([limit, offset]) => [limit, offset])).toEqual([[20, 0], [20, 20], [20, 20]]);
    expect(screen.getByText(copy30.questions.historyCount(21))).toBeInTheDocument();
  });

  it('stops after an empty final page with a positive total and reuses cached first-page data on return', async () => {
    const api = fakeApi();
    const firstPage = Array.from({ length: 20 }, (_, index) => result({ id: `cache-${String(index)}`, question: `Кэшированный вопрос ${String(index)}` }));
    const cache = { current: null as QuestionsHistoryCache | null };
    api.listQuestions.mockResolvedValueOnce({ items: firstPage, total: 25, limit: 20, offset: 0, quota: result().quota })
      .mockResolvedValueOnce({ items: [], total: 25, limit: 20, offset: 20, quota: result().quota });
    const initial = render(<QuestionsScreen api={api} telegram={fakeTelegram()} subscribed onChartGone={vi.fn()} cache={cache.current} onCacheChange={(value) => { cache.current = value; }}/>);
    expect(await screen.findByRole('button', { name: /Кэшированный вопрос 0/ })).toBeInTheDocument();
    await waitFor(() => { expect(cache.current).not.toBeNull(); });
    fireEvent.click(screen.getByRole('button', { name: copy30.questions.loadMore }));
    await waitFor(() => { expect(cache.current?.hasMore).toBe(false); });
    expect(api.listQuestions).toHaveBeenCalledTimes(2);
    expect(screen.queryByText(copy30.questions.historyEmpty)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: copy30.questions.loadMore })).not.toBeInTheDocument();
    initial.unmount();
    render(<QuestionsScreen api={api} telegram={fakeTelegram()} subscribed onChartGone={vi.fn()} cache={cache.current} onCacheChange={(value) => { cache.current = value; }}/>);
    expect(screen.getByRole('button', { name: /Кэшированный вопрос 0/ })).toBeInTheDocument();
    expect(api.listQuestions).toHaveBeenCalledTimes(2);
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
