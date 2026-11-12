/** What a bot's username may be: the rule apps/api applies to its `BOT_USERNAME`, so one name fits both. */
const USERNAME = /^[A-Za-z0-9_]{4,32}$/;
/** What a `startapp` value may consist of. A chart id is a UUID, so it always fits. */
const START_PARAM = /^[A-Za-z0-9_-]{1,64}$/;

/** The bot's username the way a link takes it: without `@`. Empty for anything that is not a username. */
export function botUsernameOf(raw: string | undefined): string {
  const name = (raw ?? '').trim().replace(/^@/, '');
  return USERNAME.test(name) ? name : '';
}

/**
 * The link that goes out with a shared chart, by the contract's template
 * (`x-bot.share_link_template`): it opens the Mini App through the bot. Null without a
 * bot to name: no link is better than one that opens nothing.
 */
export function botShareLink(botUsername: string, chartId: string): string | null {
  if (botUsername === '' || !START_PARAM.test(`chart_${chartId}`)) return null;
  return `https://t.me/${botUsername}?startapp=chart_${chartId}`;
}
