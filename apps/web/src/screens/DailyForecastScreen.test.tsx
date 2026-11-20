import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ForecastDay } from '../api';
import { apiError, fakeApi, fakeTelegram, meWithChart } from '../test/fixtures';
import { DailyForecastScreen } from './DailyForecastScreen';

const day = (overrides: Partial<ForecastDay> = {}): ForecastDay => ({ date: '2026-11-20', timezone: 'Europe/Amsterdam', status: 'facts_only', access: 'facts_only', sections: [], chars: 0, warnings: [], facts: { moon_sign: 'Лев', moon_phase: 'убывающая', illumination: 0.536 }, disclaimer: 'Серверный дисклеймер.', ...overrides });
function renderScreen({ chartId = 'chart-id', known = null, answer = day() }: { chartId?: string | null; known?: ForecastDay | null; answer?: ForecastDay | Error | Promise<ForecastDay> } = {}) {
  const api = fakeApi();
  api.getForecastToday.mockImplementation(() => answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer));
  const onKnown = vi.fn();
  const onBuildChart = vi.fn();
  const onSubscribe = vi.fn();
  const view = render(<DailyForecastScreen api={api} chartId={chartId} telegram={fakeTelegram()} known={known} onKnown={onKnown} onBuildChart={onBuildChart} onSubscribe={onSubscribe}/>);
  return { ...view, api, onKnown, onBuildChart, onSubscribe };
}
afterEach(() => vi.useRealTimers());

describe('DailyForecastScreen', () => {
  it('does not request a forecast without a chart and offers to build one', () => {
    const { api, onBuildChart } = renderScreen({ chartId: null });
    expect(screen.getByText('Сначала построй карту')).toBeInTheDocument();
    expect(api.getForecastToday).not.toHaveBeenCalled();
    screen.getByRole('button', { name: 'Построить карту' }).click();
    expect(onBuildChart).toHaveBeenCalledOnce();
  });
  it('shows only the three facts and the subscription way under facts, with no generated time or character count', async () => {
    const { api, onKnown, onSubscribe } = renderScreen();
    expect(await screen.findByText('Освещённость: 54%')).toBeInTheDocument();
    expect(screen.getByText('Луна в знаке: Лев')).toBeInTheDocument();
    expect(screen.getByText('Фаза Луны: убывающая')).toBeInTheDocument();
    expect(screen.getByText('Серверный дисклеймер.')).toBeInTheDocument();
    expect(screen.queryByText(/generated_at|chars|0 знаков/i)).not.toBeInTheDocument();
    expect(api.getForecastToday).toHaveBeenCalledOnce();
    expect(onKnown).toHaveBeenCalledOnce();
    screen.getByRole('button', { name: 'Открыть подписку' }).click();
    expect(onSubscribe).toHaveBeenCalledOnce();
  });
  it('renders only returned facts: empty facts make no block, partial facts stay partial, and a real zero is shown', async () => {
    const { rerender } = renderScreen({ answer: day({ facts: {} }) });
    await screen.findByText(/Europe\/Amsterdam/);
    expect(document.querySelector('[class*="facts"]')).toBeNull();
    expect(screen.queryByText(/Освещённость:|Луна в знаке:|Фаза Луны:/)).not.toBeInTheDocument();
    rerender(<DailyForecastScreen api={fakeApi()} chartId="chart-id" telegram={fakeTelegram()} known={day({ facts: { moon_sign: 'Овен' } })} onKnown={vi.fn()} onBuildChart={vi.fn()}/>);
    expect(screen.getByText('Луна в знаке: Овен')).toBeInTheDocument();
    expect(screen.queryByText(/Освещённость:|Фаза Луны:/)).not.toBeInTheDocument();
    rerender(<DailyForecastScreen api={fakeApi()} chartId="chart-id" telegram={fakeTelegram()} known={day({ facts: { illumination: 0 } })} onKnown={vi.fn()} onBuildChart={vi.fn()}/>);
    expect(screen.getByText('Освещённость: 0%')).toBeInTheDocument();
    expect(screen.queryByText(/Луна в знаке:|Фаза Луны:/)).not.toBeInTheDocument();
  });

  it('shows the response after twenty seconds rather than confusing a slow live response with offline', async () => {
    vi.useFakeTimers();
    let resolve!: (value: ForecastDay) => void;
    const pending = new Promise<ForecastDay>((done) => { resolve = done; });
    renderScreen({ answer: pending });
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    expect(screen.queryByText('Нет связи')).not.toBeInTheDocument();
    await act(async () => { resolve(day()); await pending; });
    expect(screen.getByText('Луна в знаке: Лев')).toBeInTheDocument();
  });

  it('shows timeout separately from offline and refreshes the quota after the failed request', async () => {
    const { api } = renderScreen({ answer: apiError('TIMEOUT') });
    api.getMe.mockResolvedValue({ ...meWithChart, quotas: [{ code: 'forecast_daily', used: 1, limit: 5, reset_at: '2026-11-16T00:00:00Z' }] });
    expect(await screen.findByRole('heading', { name: 'Прогноз не успел собраться' })).toBeInTheDocument();
    expect(screen.getByText('Попробуй ещё раз.')).toBeInTheDocument();
    expect(screen.queryByText('Нет связи')).not.toBeInTheDocument();
    expect(await screen.findByText(/Прогнозы на день:/)).toBeInTheDocument();
    expect(api.getMe).toHaveBeenCalledOnce();
  });

  it('renders the summary, three server sections and the separate one-step card; only shows the allowed warning', async () => {
    const ready = day({ status: 'ready', access: 'subscription', sections: [
      { key: 'summary', title: 'Итог дня', body: 'Короткое резюме.' }, { key: 'easier', title: 'Где легче', body: 'Раздел один.' }, { key: 'careful', title: 'На что смотреть', body: 'Раздел два.' }, { key: 'step', title: 'Шаг на день', body: 'Одно действие.' },
    ], warnings: ['length_off'] });
    renderScreen({ answer: ready });
    expect(await screen.findByText('Короткое резюме.')).toBeInTheDocument();
    expect(screen.getByText('Одно действие.').closest('section')).toHaveTextContent('Один шаг');
    expect(screen.getByText('Текст немного короче обычного')).toBeInTheDocument();
  });
  it('waits five seconds before the usual-duration note and has four skeleton blocks', async () => {
    vi.useFakeTimers();
    let resolve!: (value: ForecastDay) => void;
    const pending = new Promise<ForecastDay>((done) => { resolve = done; });
    renderScreen({ answer: pending });
    expect(screen.getAllByRole('status')).toHaveLength(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(screen.getByText('Обычно до 25 секунд')).toBeInTheDocument();
    await act(async () => { resolve(day()); await pending; });
    expect(screen.getByText('Луна в знаке: Лев')).toBeInTheDocument();
  });
  it('reuses an already-known response without flashing a skeleton or requesting again, and uses server date and timezone', () => {
    const { api } = renderScreen({ known: day() });
    expect(screen.getByText('20 ноября 2026 г.')).toBeInTheDocument();
    expect(screen.getByText(/Europe\/Amsterdam/)).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(api.getForecastToday).not.toHaveBeenCalled();
  });
  it('retries after the 503 cooldown and makes exactly one fresh request', async () => {
    vi.useFakeTimers();
    const api = fakeApi();
    api.getForecastToday.mockRejectedValueOnce(apiError('UPSTREAM_LLM', { status: 503 })).mockResolvedValueOnce(day());
    render(<DailyForecastScreen api={api} chartId="chart-id" telegram={fakeTelegram()} known={null} onKnown={vi.fn()} onBuildChart={vi.fn()} onSubscribe={vi.fn()}/>);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); await Promise.resolve(); await Promise.resolve(); });
    expect(screen.getByRole('button', { name: /Попробовать снова через/ })).toBeDisabled();
    for (let second = 0; second < 61; second += 1) await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    const retry = screen.getByRole('button', { name: 'Попробовать снова' });
    expect(retry).toBeEnabled();
    await act(async () => { retry.click(); await Promise.resolve(); await Promise.resolve(); });
    expect(screen.getByText('Луна в знаке: Лев')).toBeInTheDocument();
    expect(api.getForecastToday).toHaveBeenCalledTimes(2);
  });
  it('recovers from offline and replaces the error with the fresh server response', async () => {
    const { api } = renderScreen({ answer: apiError('NETWORK') });
    expect(await screen.findByRole('heading', { name: 'Нет связи' })).toBeInTheDocument();
    api.getForecastToday.mockResolvedValueOnce(day());
    screen.getByRole('button', { name: 'Попробовать снова' }).click();
    expect(await screen.findByText('Луна в знаке: Лев')).toBeInTheDocument();
    expect(api.getForecastToday).toHaveBeenCalledTimes(2);
  });
  it('uses the response date even when it differs from the phone date, and ignores unknown warnings', async () => {
    renderScreen({ answer: day({ date: '2026-11-19', warnings: ['ungrounded', 'future_internal_code'] as unknown as ForecastDay['warnings'] }) });
    expect(await screen.findByText('19 ноября 2026 г.')).toBeInTheDocument();
    expect(screen.getByText(/Europe\/Amsterdam/)).toBeInTheDocument();
    expect(screen.queryByText('ungrounded')).not.toBeInTheDocument();
    expect(screen.queryByText('future_internal_code')).not.toBeInTheDocument();
  });
  it('shows only length_off as a forecast warning even when other codes are present', async () => {
    renderScreen({ answer: day({ status: 'ready', access: 'subscription', sections: [{ key: 'summary', title: 'Итог', body: 'Текст' }], warnings: ['length_off', 'ungrounded', 'future_internal_code'] as unknown as ForecastDay['warnings'] }) });
    expect(await screen.findByText('Текст немного короче обычного')).toBeInTheDocument();
    expect(screen.queryByText('ungrounded')).not.toBeInTheDocument();
    expect(screen.queryByText('future_internal_code')).not.toBeInTheDocument();
  });
  it('keeps facts_only empty of generated timestamps and windows even when an optional date is present', async () => {
    renderScreen({ answer: day({ generated_at: '2026-11-15T15:00:00Z', sections: [], chars: 0, facts: { moon_sign: 'Лев', moon_phase: 'убывающая', illumination: 0.72 } }) });
    expect(await screen.findByText('Освещённость: 72%')).toBeInTheDocument();
    expect(screen.getByText('Луна в знаке: Лев')).toBeInTheDocument();
    expect(screen.getByText('Фаза Луны: убывающая')).toBeInTheDocument();
    expect(screen.getByText('Луна в знаке: Лев').parentElement?.querySelectorAll('p')).toHaveLength(3);
    expect(screen.queryByText(/generated_at|15:00|0 знаков/i)).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Открыть подписку' })).toHaveLength(1);
  });
  it('pauses for forecast_month_cap without retrying and keeps the support route', async () => {
    const { api } = renderScreen({ answer: apiError('RATE_LIMITED', { status: 429, details: { reason: 'forecast_month_cap' } }) });
    expect(await screen.findByText('Прогнозы приостановлены до следующего месяца.')).toBeInTheDocument();
    expect(screen.queryByText(/forecast_month_cap|429/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Попробовать снова' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Контакт поддержки ещё не задан' })).toBeDisabled();
    expect(api.getForecastToday).toHaveBeenCalledOnce();
  });
  it('shows neutral service wording and prevents a retry for sixty seconds', async () => {
    const { api } = renderScreen({ answer: apiError('UPSTREAM_LLM', { status: 503 }) });
    expect(await screen.findByText('Прогноз временно недоступен.')).toBeInTheDocument();
    expect(screen.queryByText(/UPSTREAM|503|forecast_failed/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/вчерашний текст|прогноз за вчера/i)).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Сегодня прогноз не собрался' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Попробовать снова через/ })).toBeDisabled();
    expect(api.getForecastToday).toHaveBeenCalledOnce();
  });
});
