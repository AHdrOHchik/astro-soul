/** A Telegram username, the way apps/api checks the bot's. */
const USERNAME = /^[A-Za-z0-9_]{4,32}$/;

/**
 * Where the support button leads, from what the owner set at build time: a Telegram
 * username (with or without `@`) or an https link. Empty for anything else, and for
 * nothing: the button then says that support is not there yet instead of leading nowhere.
 */
export function supportLinkOf(raw: string | undefined): string {
  const value = (raw ?? '').trim();
  if (value === '') return '';
  const name = value.replace(/^@/, '');
  if (USERNAME.test(name)) return `https://t.me/${name}`;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.href : '';
  } catch {
    return '';
  }
}
