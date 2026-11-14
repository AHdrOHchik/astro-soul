/*
 * What a bundle is built with, read from the environment of whoever builds it. Nothing in
 * the repository sets these values for a release: the owner builds by hand, so a variable
 * that was forgotten has to be seen. The build says these four lines before anything else.
 *
 * Node side only: `vite.config.ts` and `scripts/print-build-settings.ts` call it, the app does not.
 */
import { CONSENT_VERSION } from '../src/i18n/consentVersion.ts';
import { botUsernameOf } from '../src/lib/share.ts';
import { SUBSCRIPTION_MODES, subscriptionsModeOf } from '../src/lib/subscriptions.ts';
import { supportLinkOf } from '../src/lib/support.ts';

/** The variables read here, as `loadEnv` or `process.env` hands them over. */
export type BuildEnv = Readonly<Record<string, string | undefined>>;

export interface BuildSettings {
  /** Whether the bundle sells subscriptions: only with `VITE_SUBSCRIPTIONS=enabled`. */
  subscriptions: boolean;
  /** Where the support button leads; '' = no contact, the button is disabled. */
  supportLink: string;
  /** The bot's username without `@`; '' = a shared chart carries no link. */
  botUsername: string;
  /** The same in plain words, in a fixed order: what the build prints. */
  lines: string[];
}

/** A link to a Telegram account, the way `supportLinkOf` makes one of a username. */
const TELEGRAM_ACCOUNT = /^https:\/\/t\.me\/([A-Za-z0-9_]{4,32})$/;

/** One line: the name, then the value in the same column on every line. */
const line = (name: string, value: string) => `${`${name}:`.padEnd(15)}${value}`;

/**
 * Reads the settings of a build. A value that is missing is not an error: the app works
 * without it, and the lines say what it will be like. A value nobody can read is one:
 * taken for «not set», it would be a release that quietly differs from what the owner meant.
 */
export function readBuildSettings(env: BuildEnv): BuildSettings {
  const mode = subscriptionsModeOf(env.VITE_SUBSCRIPTIONS);
  // What is sold must never depend on a typo: `of` is neither «sell» nor «do not sell».
  if (mode === null) {
    throw new Error(
      `VITE_SUBSCRIPTIONS is «${env.VITE_SUBSCRIPTIONS ?? ''}». Expected ${SUBSCRIPTION_MODES.join(' or ')}, or nothing (the same as off).`,
    );
  }
  const supportLink = supportLinkOf(env.VITE_SUPPORT_CONTACT);
  // A contact the app cannot turn into a link would leave the support button disabled without a word.
  if (env.VITE_SUPPORT_CONTACT && supportLink === '') {
    throw new Error(`VITE_SUPPORT_CONTACT is neither a Telegram username nor an https link: «${env.VITE_SUPPORT_CONTACT}».`);
  }
  const botUsername = botUsernameOf(env.VITE_BOT_USERNAME);
  // The same for the bot: unnoticed, that is a release whose shared charts lead nowhere.
  if (env.VITE_BOT_USERNAME && botUsername === '') {
    throw new Error(`VITE_BOT_USERNAME is not a Telegram username: «${env.VITE_BOT_USERNAME}». Expected the bot's username, with or without @.`);
  }

  const subscriptions = mode === 'enabled';
  const account = TELEGRAM_ACCOUNT.exec(supportLink)?.[1];
  return {
    subscriptions,
    supportLink,
    botUsername,
    lines: [
      line('subscriptions', subscriptions ? 'ON SALE' : 'OFF (set VITE_SUBSCRIPTIONS=enabled to sell)'),
      line('support', supportLink === '' ? 'NOT SET → кнопка поддержки будет неактивна' : account === undefined ? supportLink : `@${account}`),
      line('bot', botUsername === '' ? 'NOT SET → «Поделиться» уйдёт без ссылки на бота' : `@${botUsername}`),
      line('consent', CONSENT_VERSION),
    ],
  };
}
