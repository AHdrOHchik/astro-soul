/*
 * The only module that talks to Telegram. The rest of the app depends on the
 * `Telegram` interface below, so swapping the SDK (its transport packages are
 * deprecated in favour of @tma.js/*) touches this file alone.
 */
import {
  backButton,
  init,
  isInvoiceSupported,
  isTMA,
  miniApp,
  openLink,
  openTelegramLink,
  postEvent,
  request,
  retrieveRawInitData,
  shareURL,
  supports,
  swipeBehavior,
  themeParams,
  toRGB,
  viewport,
} from '@telegram-apps/sdk';
import { installPolyfills } from './polyfills';

/**
 * How Telegram says an invoice was closed. Its word about what happened on the client:
 * never a proof of payment. Whether anything was bought is the server's to say.
 */
export type InvoiceStatus = 'paid' | 'cancelled' | 'failed' | 'pending';
/** `unsupported`: there was nothing to open the invoice with. */
export type InvoiceOutcome = InvoiceStatus | 'unsupported';

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
  /**
   * False where a Stars invoice cannot be opened: a plain browser, a client older than
   * Mini Apps 6.1. Asked before the server is: an invoice nobody can open is not worth creating.
   */
  readonly canPay: boolean;
  /** Opens the invoice behind `link` and tells how Telegram closed it. Never rejects. */
  openInvoice(link: string): Promise<InvoiceOutcome>;
  /** Opens `url` outside the Mini App: a chat for a t.me link, the browser for any other. */
  openLink(url: string): void;
}

/** Dev builds only: a payment without Telegram, so the screens after it can be walked in a browser. */
export interface DevInvoice {
  /** What every invoice «closes» with. */
  status: InvoiceStatus;
  /** Stands in for Telegram telling the server about the payment; called for `paid` only. */
  settle?: (link: string) => Promise<void>;
}

export interface TelegramOptions {
  /** `#rrggbb` for the client's header, background and bottom bar, so they match the page. */
  chromeColor?: string;
  /** initData to use outside Telegram; local development only. */
  devInitData?: string;
  /** Local development only, see `DevInvoice`. */
  devInvoice?: DevInvoice;
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
  console.error('[telegram]', error);
}

export function shareLink(url: string, text: string): string {
  return `https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(text)}`;
}

function openShareLink(url: string, text: string): void {
  window.open(shareLink(url, text), '_blank', 'noopener,noreferrer');
}

function openInBrowser(url: string): void {
  window.open(url, '_blank', 'noopener,noreferrer');
}

function isTelegramLink(url: string): boolean {
  try {
    return new URL(url).hostname === 't.me';
  } catch {
    return false;
  }
}

/** The slug of an invoice link: `https://t.me/$slug` or `https://t.me/invoice/slug`. Null for anything else. */
export function invoiceSlug(link: string): string | null {
  try {
    const { protocol, hostname, pathname } = new URL(link);
    if (protocol !== 'https:' || hostname !== 't.me') return null;
    return /^\/(?:\$|invoice\/)([A-Za-z0-9\-_=]+)$/.exec(pathname)?.[1] ?? null;
  } catch {
    return null;
  }
}

const INVOICE_STATUSES: readonly string[] = ['paid', 'cancelled', 'failed', 'pending'] satisfies InvoiceStatus[];

/**
 * A status Telegram may add later is read as `pending`: the one answer that claims
 * nothing, neither that the user paid nor that the user did not.
 */
function toInvoiceStatus(status: string): InvoiceStatus {
  return INVOICE_STATUSES.includes(status) ? (status as InvoiceStatus) : 'pending';
}

/** Asks the client to show the invoice and waits until it is closed. For both hosts inside Telegram. */
function openInvoiceByBridge(link: string): Promise<InvoiceOutcome> {
  const slug = invoiceSlug(link);
  if (slug === null) {
    // Not something Telegram can open. The link itself is not logged.
    report(new Error('The server sent an invoice link of an unknown form'));
    return Promise.resolve('failed');
  }
  try {
    return request('web_app_open_invoice', 'invoice_closed', { params: { slug }, capture: (event) => event.slug === slug }).then(
      (event): InvoiceOutcome => toInvoiceStatus(event.status),
      (error: unknown): InvoiceOutcome => {
        report(error);
        return 'unsupported';
      },
    );
  } catch (error) {
    report(error);
    return Promise.resolve('unsupported');
  }
}

/** How long the pretended invoice of a dev build stays «open». */
const DEV_INVOICE_DELAY_MS = 800;

/** The app as an ordinary web page: local development, tests, a link opened outside Telegram. */
function browserHost(initData: string, devInvoice?: DevInvoice): Telegram {
  return {
    isTelegram: false,
    initData,
    hasNativeBackButton: false,
    setBackHandler: () => undefined,
    ready: () => undefined,
    share: openShareLink,
    close: () => undefined,
    canPay: devInvoice !== undefined,
    async openInvoice(link) {
      // Nothing to open it with. The paywall asks `canPay` first and says so itself.
      if (devInvoice === undefined) return 'unsupported';
      await new Promise((resolve) => setTimeout(resolve, DEV_INVOICE_DELAY_MS));
      if (devInvoice.status === 'paid') await devInvoice.settle?.(link).catch(report);
      return devInvoice.status;
    },
    openLink: openInBrowser,
  };
}

/**
 * Launch parameters as every Telegram client passes them, in the URL hash, read
 * without the SDK. Null when there are none: the page is not inside Telegram.
 */
function launchFromUrl(): { initData: string; version: string } | null {
  const params = new URLSearchParams(window.location.hash.slice(1));
  if (!params.has('tgWebAppVersion') && !params.has('tgWebAppData')) return null;
  return { initData: params.get('tgWebAppData') ?? '', version: params.get('tgWebAppVersion') ?? '' };
}

/** Whether a client of this Mini Apps version (`7.10`) can open an invoice; false for anything that is not a version. */
function versionOpensInvoices(version: string): boolean {
  try {
    return /^\d+(\.\d+)*$/.test(version) && supports('web_app_open_invoice', version);
  } catch {
    return false;
  }
}

/**
 * Inside Telegram, but without the SDK. The SDK checks launch parameters
 * against a strict schema (init data lacking `signature` or `auth_date` fails
 * it) and then reports that the app is not in Telegram at all. Signing in needs
 * only the raw init data, which the server validates itself, so the app must not
 * depend on that schema: it runs as a web page with an in-app Back button, plus
 * the three bridge calls that exist since the first Mini Apps version.
 */
function basicHost(initData: string, version: string): Telegram {
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
    canPay: versionOpensInvoices(version),
    openInvoice: openInvoiceByBridge,
    openLink(url) {
      try {
        postEvent('web_app_open_link', { url });
      } catch (error) {
        report(error);
        openInBrowser(url);
      }
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

// All palette literals stay in theme.css. Work in sRGB so a pale custom
// Telegram hint/button can be corrected for the surfaces it actually sits on.
function channels(hex: string): number[] {
  const full = toRGB(hex);
  return [1, 3, 5].map((offset) => parseInt(full.slice(offset, offset + 2), 16));
}

function luminance(hex: string): number {
  const [r = 0, g = 0, b = 0] = channels(hex).map((v) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const x = luminance(a) + 0.05;
  const y = luminance(b) + 0.05;
  return Math.max(x / y, y / x);
}

function mix(from: string, toward: string, fraction: number): string {
  const target = channels(toward);
  return `#${channels(from).map((c, i) => Math.round(c + ((target[i] ?? c) - c) * fraction).toString(16).padStart(2, '0')).join('')}`;
}

function legible(candidate: string, ink: string, surfaces: string[], minimum = 4.5): string {
  for (let step = 0; step < 20; step++) {
    const color = step === 0 ? candidate : mix(candidate, ink, step / 20);
    if (surfaces.every((surface) => contrast(color, surface) >= minimum)) return color;
  }
  return ink;
}

/** One subscription for the document lifetime, outside React and its navigation stack. */
function bindTheme(useSdk: boolean, fallbackChrome?: string): void {
  const root = document.documentElement;
  const preference = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  const overrides = new Set<string>();
  const apply = () => {
    const params = useSdk ? themeParams.state() : {};
    for (const name of overrides) root.style.removeProperty(name);
    overrides.clear();
    const bg = params.bg_color;
    const dark = bg ? luminance(bg) < 0.179 : preference?.matches ?? true;
    root.dataset.scheme = dark ? 'dark' : 'light';
    const css = getComputedStyle(root);
    const token = (role: string) => css.getPropertyValue(`--color-${role}`).trim();
    if (bg) {
      const set = (name: string, color: string) => {
        root.style.setProperty(name, color);
        overrides.add(name);
      };
      const put = (role: string, color: string) => { set(`--color-${role}`, color); };
      const neutral = (channel: number) => `#${channel.toString(16).padStart(2, '0').repeat(3)}`;
      const black = neutral(0);
      const white = neutral(255);
      const ink = contrast(white, bg) > contrast(black, bg) ? white : black;
      // Even a custom theme with opposite-coloured panels needs one usable text role.
      const surface = (color: string) => legible(color, bg, [ink]);
      const panel = surface(params.section_bg_color ?? params.secondary_bg_color ?? (token('surface') || bg));
      const raised = surface(params.secondary_bg_color ?? (token('surface-raised') || panel));
      const tint = (color: string) => surface(mix(panel, color, 0.08));
      const brand = token('accent') || ink;
      const soft = tint(brand);
      const goldSoft = tint(token('gold') || ink);
      const dangerSoft = tint(params.destructive_text_color ?? (token('danger') || ink));
      const surfaces = [bg, panel, raised, soft, goldSoft, dangerSoft];
      const text = (color: string) => legible(color, ink, surfaces);
      const accent = text(params.button_color ?? params.link_color ?? brand);
      put('bg', bg);
      put('surface', panel);
      put('surface-raised', raised);
      put('text', text(params.text_color ?? (token('text') || ink)));
      put('text-muted', text(params.hint_color ?? (token('text-muted') || ink)));
      put('accent', accent);
      const pressed = mix(accent, ink, 0.12);
      put('accent-pressed', pressed);
      put('on-accent', legible(params.button_text_color ?? (token('on-accent') || bg), ink === white ? black : white, [accent, pressed]));
      put('accent-soft', soft);
      put('gold-soft', goldSoft);
      put('danger-soft', dangerSoft);
      put('gold', text(token('gold') || ink));
      put('danger', text(params.destructive_text_color ?? (token('danger') || ink)));
      for (const role of ['border', 'border-strong', 'focus']) {
        put(role, legible((role !== 'focus' && params.section_separator_color) || token(role) || ink, ink, surfaces, 3));
      }
      // Tint and fade into the actual host background (including on older Safari).
      const clear = `rgba(${channels(bg).join(',')},0)`;
      set('--gradient-page', `radial-gradient(120% 55% at 50% -12%, ${soft}, ${clear} 62%)`);
      set('--gradient-scroll-fade', `linear-gradient(to bottom, ${clear}, var(--color-bg))`);
    }
    if (useSdk) paintChrome(bg ?? fallbackChrome?.trim() ?? token('bg'));
  };
  if (useSdk) themeParams.mountSync.ifAvailable();
  apply();
  if (useSdk) themeParams.state.sub(apply);
  preference?.addEventListener('change', () => { if (!useSdk || !themeParams.backgroundColor()) apply(); });
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

export function initTelegram({ chromeColor, devInitData = '', devInvoice }: TelegramOptions): Telegram {
  // Must run before the first SDK call: the SDK needs it to read launch parameters.
  installPolyfills();
  const launch = launchFromUrl();
  // Only a development build may pretend to pay, whatever it is told.
  if (!isTMA()) {
    bindTheme(false);
    return launch ? basicHost(launch.initData, launch.version) : browserHost(devInitData, import.meta.env.DEV ? devInvoice : undefined);
  }

  const initData = readInitData();
  try {
    init();
  } catch (error) {
    report(error);
    bindTheme(false);
    return basicHost(initData, launch?.version ?? '');
  }

  attempt(() => miniApp.mountSync.ifAvailable());
  attempt(() => { bindTheme(true, chromeColor); });
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
    canPay: isInvoiceSupported(),
    openInvoice: openInvoiceByBridge,
    openLink(url) {
      try {
        if (isTelegramLink(url) ? openTelegramLink.ifAvailable(url)[0] : openLink.ifAvailable(url)[0]) return;
      } catch (error) {
        report(error);
      }
      openInBrowser(url);
    },
  };
}
