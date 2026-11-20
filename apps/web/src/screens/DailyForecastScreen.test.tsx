import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ForecastDay } from '../api';
import { apiError, fakeApi, fakeTelegram } from '../test/fixtures';
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
  it('pauses for forecast_month_cap without retrying and keeps the support route', async () => {
    const { api } = renderScreen({ answer: apiError('RATE_LIMITED', { status: 429, details: { reason: 'forecast_month_cap' } }) });
    expect(await screen.findByText('Прогнозы приостановлены до следующего месяца.')).toBeInTheDocument();
    expect(screen.queryByText(/forecast_month_cap|429/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Повторить' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Контакт поддержки ещё не задан' })).toBeDisabled();
    expect(api.getForecastToday).toHaveBeenCalledOnce();
  });
  it('shows neutral service wording and prevents a retry for sixty seconds', async () => {
    const { api } = renderScreen({ answer: apiError('UPSTREAM_LLM', { status: 503 }) });
    expect(await screen.findByText('Прогноз временно недоступен.')).toBeInTheDocument();
    expect(screen.queryByText(/UPSTREAM|503|forecast_failed/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Повторить через/ })).toBeDisabled();
    expect(api.getForecastToday).toHaveBeenCalledOnce();
  });
});
