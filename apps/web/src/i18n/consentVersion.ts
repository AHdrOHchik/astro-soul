/**
 * Version of the legal texts of the app (src/i18n/ru.ts), sent as `consent.version` in
 * `POST /charts`. The server stores it next to the user's consent and accepts no other
 * version than its own: a release with a new version of the texts has to carry the new
 * date here (YYYY-MM-DD).
 *
 * Alone in its file and importing nothing: the build prints it among its settings
 * (scripts/buildSettings.ts), and Node runs that script as it is.
 */
export const CONSENT_VERSION = '2026-11-10';
