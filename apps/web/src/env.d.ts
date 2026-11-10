/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** API origin without the /api/v1 suffix; empty = same origin. */
  readonly VITE_API_BASE_URL?: string;
  /** Dev builds only: raw initData to send when the app runs outside Telegram. */
  readonly VITE_DEV_INIT_DATA?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
