import { useCallback } from 'react';
import type { Api, Forecast } from '../../api';
import { useRequest } from '../../hooks/useRequest';
import { formatDayMonth } from '../../i18n/format';
import { localDayIn } from '../../lib/localDay';

/** What the app last heard about the forecast of a chart, to show at once while the server is asked again. */
export interface KnownForecast {
  chartId: string;
  forecast: Forecast;
}

export type ForecastView =
  /** The answer is on its way and nothing is known yet. */
  | { kind: 'loading' }
  | { kind: 'ready'; forecast: Forecast }
  /** The server has no forecast for today (404): its nightly job has not written one. Not a failure. */
  | { kind: 'pending' }
  | { kind: 'error'; error: unknown };

export interface UseForecastOptions {
  api: Pick<Api, 'getForecast'>;
  chartId: string;
  known?: KnownForecast | null;
  /** The server's fresh word: a forecast, or null for «none yet». Keep the reference stable: a new function is a new request. */
  onKnown?: (chartId: string, forecast: Forecast | null) => void;
}

/**
 * Reads the forecast of a chart: one request when the screen opens, and one more for every
 * tap on «retry» after a failure. Never another one by itself. The server prepares
 * forecasts at night and answers at once with what it has: one that is not there yet does
 * not come sooner for being asked for again, so «none yet» is a state to show, not to wait out.
 */
export function useForecast({ api, chartId, known = null, onKnown }: UseForecastOptions): { view: ForecastView; retry: () => void } {
  const load = useCallback(
    async (signal: AbortSignal) => {
      const forecast = await api.getForecast(chartId, signal);
      if (!signal.aborted) onKnown?.(chartId, forecast);
      return forecast;
    },
    [api, chartId, onKnown],
  );
  const state = useRequest(load);
  const heard = known !== null && known.chartId === chartId ? known.forecast : null;

  let view: ForecastView;
  if (state.status === 'ready') view = state.data === null ? { kind: 'pending' } : { kind: 'ready', forecast: state.data };
  // What the server said last stands in while it is asked again, and stays when that question got no answer.
  else if (heard !== null) view = { kind: 'ready', forecast: heard };
  else if (state.status === 'loading') view = { kind: 'loading' };
  else view = { kind: 'error', error: state.error };
  return { view, retry: state.retry };
}

/**
 * Which day a forecast is for, in words. `today` only when its date is the calendar day it
 * is right now at the birth place (`timeZone`), not on the device: the server counts days
 * there. Without a zone nobody can tell, so it is not today.
 */
export function forecastDay(forecast: Forecast, timeZone: string | null, now: Date): { today: boolean; day: string } {
  return { today: localDayIn(timeZone, now) === forecast.date, day: formatDayMonth(forecast.date) };
}

/** The first sentence of a text: what the chart screen shows of a forecast. The whole text when no sentence ends in it. */
export function firstSentence(text: string): string {
  const flat = text.trim().replace(/\s+/g, ' ');
  const end = /[.!?…]+(?=\s|$)/.exec(flat);
  return end ? flat.slice(0, end.index + end[0].length) : flat;
}
