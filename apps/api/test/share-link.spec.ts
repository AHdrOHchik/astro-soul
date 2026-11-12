import { describe, expect, it } from 'vitest';
import {
  buildMiniAppUrl,
  buildShareLink,
  buildStartAppValue,
  parseStartChartId,
} from '../src/modules/charts/share-link';

const CHART_ID = '0f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f';

describe('ссылки шаринга (x-bot, контракт 1.4.0)', () => {
  it('собирает ссылку по шаблону контракта', () => {
    expect(buildShareLink('astro_soul_bot', CHART_ID)).toBe(
      `https://t.me/astro_soul_bot?startapp=chart_${CHART_ID}`,
    );
  });

  it('без BOT_USERNAME ссылки нет — не врём битой ссылкой', () => {
    expect(buildShareLink(undefined, CHART_ID)).toBeNull();
    expect(buildShareLink('', CHART_ID)).toBeNull();
  });

  it('startapp-значение — chart_<uuid>', () => {
    expect(buildStartAppValue(CHART_ID)).toBe(`chart_${CHART_ID}`);
  });

  it('адрес мини-аппа получает параметр startapp', () => {
    const url = buildMiniAppUrl('https://app.astro-soul.example.com', CHART_ID);
    expect(url).toBe(
      `https://app.astro-soul.example.com/?startapp=chart_${CHART_ID}`,
    );
    expect(buildMiniAppUrl(undefined, CHART_ID)).toBeNull();
  });

  it('разбирает /start chart_<uuid>, остальное игнорирует', () => {
    expect(parseStartChartId(`/start chart_${CHART_ID}`)).toBe(CHART_ID);
    expect(parseStartChartId(`/start chart_${CHART_ID.toUpperCase()}`)).toBe(
      CHART_ID.toUpperCase(),
    );

    expect(parseStartChartId('/start')).toBeNull();
    expect(parseStartChartId('/start ref_123')).toBeNull();
    expect(parseStartChartId('/start chart_not-a-uuid')).toBeNull();
    expect(parseStartChartId('chart_' + CHART_ID)).toBeNull();
    expect(parseStartChartId(undefined)).toBeNull();
  });
});
