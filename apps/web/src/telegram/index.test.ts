import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Telegram, TelegramOptions } from './index';

/*
 * Runs against the real SDK: the test plays the Telegram client by providing
 * launch parameters in the URL and recording what the app posts to the bridge.
 */
const INIT_DATA = 'user=%7B%22id%22%3A1%2C%22first_name%22%3A%22Test%22%7D&auth_date=1700000000&hash=abc&signature=def';

const posted = vi.fn<(event: string, data?: string) => void>();
const events = () => posted.mock.calls.map(([event]) => event);
const payloadOf = (event: string): unknown => {
  const call = posted.mock.calls.find(([name]) => name === event);
  return call?.[1] ? JSON.parse(call[1]) : undefined;
};

function launchInTelegram(version: string, initData = INIT_DATA) {
  const params = new URLSearchParams({
    tgWebAppData: initData,
    tgWebAppVersion: version,
    tgWebAppPlatform: 'android',
    tgWebAppThemeParams: '{}',
  });
  window.location.hash = params.toString();
  Object.assign(window, { TelegramWebviewProxy: { postEvent: posted } });
}

async function start(options: Partial<TelegramOptions> = {}): Promise<Telegram> {
  const { initTelegram } = await import('./index');
  return initTelegram({ chromeColor: '#0f0d1a', ...options });
}

beforeEach(() => {
  vi.resetModules();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  window.location.hash = '';
  window.sessionStorage.clear();
  Reflect.deleteProperty(window, 'TelegramWebviewProxy');
  posted.mockReset();
});

describe('outside Telegram', () => {
  it('works as a plain web page and has no init data', async () => {
    const telegram = await start();
    expect(telegram).toMatchObject({ isTelegram: false, initData: '', hasNativeBackButton: false });
    telegram.setBackHandler(() => undefined);
    telegram.ready();
    telegram.close();
  });

  it('uses the development init data when given', async () => {
    expect((await start({ devInitData: 'dev=1' })).initData).toBe('dev=1');
  });

  it('shares through a t.me link in a new tab', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    (await start()).share('https://app.test/w.svg?sig=a&b', 'Моя карта');
    expect(open).toHaveBeenCalledWith(
      'https://t.me/share/url?url=https%3A%2F%2Fapp.test%2Fw.svg%3Fsig%3Da%26b&text=%D0%9C%D0%BE%D1%8F%20%D0%BA%D0%B0%D1%80%D1%82%D0%B0',
      '_blank',
      'noopener,noreferrer',
    );
  });
});

describe('inside Telegram', () => {
  it('hands the raw init data to the app untouched', async () => {
    launchInTelegram('8.0');
    const telegram = await start();
    expect(telegram.isTelegram).toBe(true);
    expect(telegram.initData).toBe(INIT_DATA);
  });

  it('expands, paints the client chrome in the app colour and blocks swipe-to-close', async () => {
    launchInTelegram('8.0');
    await start();
    expect(events()).toEqual(expect.arrayContaining(['web_app_expand', 'web_app_setup_swipe_behavior']));
    expect(payloadOf('web_app_set_header_color')).toEqual({ color: '#0f0d1a' });
    expect(payloadOf('web_app_set_background_color')).toEqual({ color: '#0f0d1a' });
    expect(payloadOf('web_app_set_bottom_bar_color')).toEqual({ color: '#0f0d1a' });
    expect(payloadOf('web_app_setup_swipe_behavior')).toEqual({ allow_vertical_swipe: false });
  });

  it('shows the native Back button only while a handler is set and routes clicks to it', async () => {
    launchInTelegram('8.0');
    const telegram = await start();
    expect(telegram.hasNativeBackButton).toBe(true);
    const visibility = () =>
      posted.mock.calls.filter(([event]) => event === 'web_app_setup_back_button').map(([, data]) => data);

    const onBack = vi.fn();
    telegram.setBackHandler(onBack);
    expect(visibility().pop()).toBe('{"is_visible":true}');

    const { emitEvent } = await import('@telegram-apps/sdk');
    emitEvent('back_button_pressed');
    expect(onBack).toHaveBeenCalledTimes(1);

    telegram.setBackHandler(null);
    expect(visibility().pop()).toBe('{"is_visible":false}');
    emitEvent('back_button_pressed');
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('replaces the previous Back handler instead of stacking them', async () => {
    launchInTelegram('8.0');
    const telegram = await start();
    const first = vi.fn();
    const second = vi.fn();
    telegram.setBackHandler(first);
    telegram.setBackHandler(second);

    const { emitEvent } = await import('@telegram-apps/sdk');
    emitEvent('back_button_pressed');

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('reports readiness and shares through the client', async () => {
    launchInTelegram('8.0');
    const telegram = await start();
    telegram.ready();
    telegram.share('https://app.test/w.svg', 'Моя карта');
    expect(events()).toContain('web_app_ready');
    const { path_full: path } = payloadOf('web_app_open_tg_link') as { path_full: string };
    const link = new URL(path, 'https://t.me');
    expect(link.pathname).toBe('/share/url');
    expect(link.searchParams.get('url')).toBe('https://app.test/w.svg');
    expect(link.searchParams.get('text')).toBe('Моя карта');
  });

  it('starts on engines without Object.hasOwn (Safari 15.0–15.3, Chromium before 93)', async () => {
    launchInTelegram('8.0');
    const { initTelegram } = await import('./index');
    const native = Object.getOwnPropertyDescriptor(Object, 'hasOwn');
    // Removed only for the synchronous start below: the test runner itself needs it.
    Reflect.deleteProperty(Object, 'hasOwn');
    let telegram: Telegram;
    try {
      telegram = initTelegram({ chromeColor: '#0f0d1a' });
    } finally {
      if (native) Object.defineProperty(Object, 'hasOwn', native);
    }

    expect(telegram.isTelegram).toBe(true);
    expect(telegram.initData).toBe(INIT_DATA);
    expect(telegram.hasNativeBackButton).toBe(true);
  });

  it('accepts a colour that the CSS minifier shortened to #rgb', async () => {
    launchInTelegram('8.0');
    await start({ chromeColor: ' #123 ' });
    expect(payloadOf('web_app_set_header_color')).toEqual({ color: '#112233' });
  });

  it('falls back to an in-app Back button on clients older than Mini Apps 6.1', async () => {
    launchInTelegram('6.0');
    const telegram = await start();
    expect(telegram.hasNativeBackButton).toBe(false);
    telegram.setBackHandler(() => undefined);
    expect(events()).not.toContain('web_app_setup_back_button');
    expect(events()).not.toContain('web_app_set_header_color');
  });
});

describe('inside Telegram with launch parameters the SDK rejects', () => {
  // The SDK schema wants `signature` in init data; this one has none, so the SDK says "not in Telegram".
  const UNSIGNED_INIT_DATA = 'query_id=AAF0&user=%7B%22id%22%3A1%2C%22first_name%22%3A%22Test%22%7D&auth_date=1700000000&hash=abc';

  it('still signs in: the raw init data goes to the API untouched', async () => {
    launchInTelegram('7.10', UNSIGNED_INIT_DATA);
    const telegram = await start({ devInitData: 'dev=1' });
    expect(telegram.isTelegram).toBe(true);
    expect(telegram.initData).toBe(UNSIGNED_INIT_DATA);
  });

  it('runs as a web page with an in-app Back button and the calls every client knows', async () => {
    launchInTelegram('7.10', UNSIGNED_INIT_DATA);
    const telegram = await start();
    expect(telegram.hasNativeBackButton).toBe(false);
    expect(events()).toEqual(['web_app_expand']);

    telegram.setBackHandler(() => undefined);
    telegram.ready();
    telegram.close();
    expect(events()).toEqual(['web_app_expand', 'web_app_ready', 'web_app_close']);

    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    telegram.share('https://app.test/w.svg', 'text');
    expect(open).toHaveBeenCalledWith('https://t.me/share/url?url=https%3A%2F%2Fapp.test%2Fw.svg&text=text', '_blank', 'noopener,noreferrer');
  });

  it('knows it is inside Telegram even when init data came empty', async () => {
    // `tgWebAppData=` fails the schema too. The API will answer 401, and the app
    // has to say "reopen the app", not "open it in Telegram", and never fall back to dev data.
    launchInTelegram('8.0', '');
    const telegram = await start({ devInitData: 'dev=1' });
    expect(telegram).toMatchObject({ isTelegram: true, initData: '', hasNativeBackButton: false });
  });
});
