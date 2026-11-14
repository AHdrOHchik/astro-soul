import { botUsernameOf } from './lib/share';
import { supportLinkOf } from './lib/support';
import type { InvoiceStatus } from './telegram';

const INVOICE_STATUSES: readonly string[] = ['paid', 'cancelled', 'failed', 'pending'] satisfies InvoiceStatus[];

function invoiceStatusOf(raw: string | undefined): InvoiceStatus | undefined {
  return raw !== undefined && INVOICE_STATUSES.includes(raw) ? (raw as InvoiceStatus) : undefined;
}

/*
 * `import.meta.env` is read key by key on purpose. Vite replaces such reads
 * with constants; touching the object as a whole makes it inline every VITE_*
 * value into the bundle, the dev-only ones included (scripts/check-bundle.mjs
 * fails the build if that happens).
 */
export const config = {
  /** API origin without a trailing slash. Empty = same origin (dev server proxy). */
  apiBaseUrl: (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/+$/, ''),
  /** The bot's username for the link in a shared message, without `@`. Empty = the picture and the text go out without a link. */
  botUsername: botUsernameOf(import.meta.env.VITE_BOT_USERNAME),
  /** Where the support button leads. Empty = the button is there, disabled, and says support is coming. */
  supportLink: supportLinkOf(import.meta.env.VITE_SUPPORT_CONTACT),
  /** Stand-in for Telegram initData in a plain browser. Not present in production builds at all. */
  devInitData: import.meta.env.DEV ? (import.meta.env.VITE_DEV_INIT_DATA ?? '') : '',
  /**
   * How a pretended invoice ends in a plain browser: `paid`, `cancelled`, `failed` or `pending`.
   * Unset = no pretending, the paywall says payment needs Telegram. Not present in production builds at all.
   */
  devInvoice: import.meta.env.DEV ? invoiceStatusOf(import.meta.env.VITE_DEV_INVOICE) : undefined,
} as const;
