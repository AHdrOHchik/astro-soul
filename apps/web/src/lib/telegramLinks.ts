/**
 * Where Telegram keeps the user's Stars subscriptions. The app cannot cancel one: the API
 * has no such call, and Telegram has no other place for it.
 */
export const TELEGRAM_SUBSCRIPTIONS = 'tg://settings/star_subscriptions';
