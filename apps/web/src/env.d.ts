/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** API origin without the /api/v1 suffix; empty = same origin. */
  readonly VITE_API_BASE_URL?: string;
  /** Username of the bot the Mini App belongs to, with or without `@`. Empty = shared messages carry no link to it. */
  readonly VITE_BOT_USERNAME?: string;
  /** Where the support button leads: a Telegram username or an https link. Empty = the button is disabled. */
  readonly VITE_SUPPORT_CONTACT?: string;
  /** Dev builds only: raw initData to send when the app runs outside Telegram. */
  readonly VITE_DEV_INIT_DATA?: string;
  /** Dev builds only: how a pretended invoice ends outside Telegram (`paid`, `cancelled`, `failed`, `pending`). */
  readonly VITE_DEV_INVOICE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
