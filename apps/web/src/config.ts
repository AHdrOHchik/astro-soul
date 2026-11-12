import { botUsernameOf } from './lib/share';

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
  /** Stand-in for Telegram initData in a plain browser. Not present in production builds at all. */
  devInitData: import.meta.env.DEV ? (import.meta.env.VITE_DEV_INIT_DATA ?? '') : '',
} as const;
