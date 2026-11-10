/*
 * The only module that talks to Telegram. The rest of the app depends on the
 * `Telegram` interface below, so swapping the SDK (its transport packages are
 * deprecated in favour of @tma.js/*) touches this file alone.
 */
import {
  backButton,
  init,
  isTMA,
  miniApp,
  postEvent,
  retrieveRawInitData,
  shareURL,
  swipeBehavior,
  toRGB,
  viewport,
} from '@telegram-apps/sdk';
import { installPolyfills } from './polyfills';

export interface Telegram {
  /** True when the app runs inside a Telegram client. */
  readonly isTelegram: boolean;
  /** Raw initData for the API auth header; '' when there is none. */
  readonly initData: string;
  /** True when the client draws its own Back button, so the app must not render a second one. */
  readonly hasNativeBackButton: boolean;
  /** Shows the native Back button wired to `handler`; null hides it. */
  setBackHandler(handler: (() => void) | null): void;
  /** Tells Telegram the first screen is drawn, so it removes its loading placeholder. */
  ready(): void;
  /** Lets the user pick a chat to send `url` with `text` to. */
  share(url: string, text: string): void;
  /** Closes the Mini App. Does nothing in a plain browser. */
  close(): void;
}

export interface TelegramOptions {
  /** `#rrggbb` for the client's header, background and bottom bar, so they match the page. */
  chromeColor: string;
  /** initData to use outside Telegram; local development only. */
  devInitData?: string;
}

/** Runs one optional host call; a client that rejects it must not take the app down. */
function attempt(action: () => unknown): void {
  try {
    const result = action();
    if (result instanceof Promise) result.catch(report);
  } catch (error) {
    report(error);
  }
}

function report(error: unknown): void {
  console.warn('[telegram]', error);
}

export function shareLink(url: string, text: string): string {
  return `https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(text)}`;
}

function openShareLink(url: string, text: string): void {
  window.open(shareLink(url, text), '_blank', 'noopener,noreferrer');
}

/** The app as an ordinary web page: local development, tests, a link opened outside Telegram. */
function browserHost(initData: string): Telegram {
  return {
    isTelegram: false,
    initData,
    hasNativeBackButton: false,
    setBackHandler: () => undefined,
    ready: () => undefined,
    share: openShareLink,
    close: () => undefined,
  };
}

/**
 * Launch parameters as every Telegram client passes them, in the URL hash, read
 * without the SDK. Null when there are none: the page is not inside Telegram.
 */
function launchFromUrl(): { initData: string } | null {
  const params = new URLSearchParams(window.location.hash.slice(1));
  if (!params.has('tgWebAppVersion') && !params.has('tgWebAppData')) return null;
  return { initData: params.get('tgWebAppData') ?? '' };
}

/**
 * Inside Telegram, but without the SDK. The SDK checks launch parameters
 * against a strict schema (init data lacking `signature` or `auth_date` fails
 * it) and then reports that the app is not in Telegram at all. Signing in needs
 * only the raw init data, which the server validates itself, so the app must not
 * depend on that schema: it runs as a web page with an in-app Back button, plus
 * the three bridge calls that exist since the first Mini Apps version.
 */
function basicHost(initData: string): Telegram {
  attempt(() => {
    postEvent('web_app_expand');
  });
  return {
    isTelegram: true,
    initData,
    hasNativeBackButton: false,
    setBackHandler: () => undefined,
    ready() {
      attempt(() => {
        postEvent('web_app_ready');
      });
    },
    share: openShareLink,
    close() {
      attempt(() => {
        postEvent('web_app_close');
      });
    },
  };
}

function readInitData(): string {
  try {
    return retrieveRawInitData() ?? '';
  } catch (error) {
    report(error);
    return '';
  }
}

function paintChrome(cssColor: string): void {
  let color: ReturnType<typeof toRGB>;
  try {
    // Telegram takes #rrggbb only, while a CSS minifier is free to shorten the token to #rgb.
    color = toRGB(cssColor);
  } catch (error) {
    report(error);
    return;
  }
  attempt(() => miniApp.mountSync.ifAvailable());
  attempt(() => {
    // Old clients accept only palette keys for the header; they keep the user's own colour.
    if (miniApp.setHeaderColor.isAvailable() && miniApp.setHeaderColor.supports.rgb()) miniApp.setHeaderColor(color);
  });
  attempt(() => miniApp.setBackgroundColor.ifAvailable(color));
  attempt(() => miniApp.setBottomBarColor.ifAvailable(color));
}

function fitViewport(): void {
  attempt(() => viewport.expand.ifAvailable());
  attempt(() => {
    if (!viewport.mount.isAvailable() || viewport.isMounting()) return undefined;
    // Publishes --tg-viewport-* (height, safe-area insets) that theme.css builds on.
    return viewport.mount().then(() => {
      viewport.bindCssVars.ifAvailable();
    });
  });
  // The forms keep their input in memory only; a stray swipe down must not close the app and lose it.
  attempt(() => swipeBehavior.mount.ifAvailable());
  attempt(() => swipeBehavior.disableVertical.ifAvailable());
}

export function initTelegram({ chromeColor, devInitData = '' }: TelegramOptions): Telegram {
  // Must run before the first SDK call: the SDK needs it to read launch parameters.
  installPolyfills();
  if (!isTMA()) {
    const launch = launchFromUrl();
    return launch ? basicHost(launch.initData) : browserHost(devInitData);
  }

  const initData = readInitData();
  try {
    init();
  } catch (error) {
    report(error);
    return basicHost(initData);
  }

  paintChrome(chromeColor.trim());
  fitViewport();
  attempt(() => backButton.mount.ifAvailable());
  const hasNativeBackButton = backButton.isMounted();
  let removeBackListener: (() => void) | undefined;

  return {
    isTelegram: true,
    initData,
    hasNativeBackButton,
    setBackHandler(handler) {
      if (!hasNativeBackButton) return;
      removeBackListener?.();
      removeBackListener = undefined;
      if (!handler) {
        attempt(() => backButton.hide.ifAvailable());
        return;
      }
      attempt(() => {
        removeBackListener = backButton.onClick.ifAvailable(handler)[1];
      });
      attempt(() => backButton.show.ifAvailable());
    },
    ready() {
      attempt(() => miniApp.ready.ifAvailable());
    },
    share(url, text) {
      try {
        if (shareURL.ifAvailable(url, text)[0]) return;
      } catch (error) {
        report(error);
      }
      openShareLink(url, text);
    },
    close() {
      attempt(() => miniApp.close.ifAvailable());
    },
  };
}
