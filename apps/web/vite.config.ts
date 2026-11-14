import react from '@vitejs/plugin-react';
import { loadEnv } from 'vite';
import { defineConfig } from 'vitest/config';
import { mockApi } from './mock/plugin.ts';
import { botUsernameOf } from './src/lib/share.ts';
import { SUBSCRIPTION_MODES, subscriptionsModeOf } from './src/lib/subscriptions.ts';
import { supportLinkOf } from './src/lib/support.ts';

/*
 * Oldest engines we promise to run on: iOS 15 (Safari 15) and the Chromium 80
 * WebView (an Android 9 device that has updated its system WebView at least
 * once; Telegram Desktop ships a far newer engine). Vite's default target is
 * newer than iOS 15, so it must stay explicit. Syntax only, no polyfills.
 */
const BROWSER_TARGET = ['es2020', 'chrome80', 'safari15'];

export default defineConfig(({ mode, command }) => {
  // `vite build` keeps a NODE_ENV that is already set, and with any value but `production`
  // (CI sets `test`) it bundles the development build of React and leaves `import.meta.env.DEV`
  // on. What `pnpm build` produces must not depend on who calls it.
  if (command === 'build') process.env.NODE_ENV = 'production';

  // Third argument '': read un-prefixed variables too. They stay in this file;
  // only VITE_* ones reach the client bundle.
  const env = loadEnv(mode, process.cwd(), '');
  const useMock = env.API_MOCK === '1';
  // The app treats a value it cannot use as no value. Unnoticed, that is a release whose shared charts lead nowhere.
  if (env.VITE_BOT_USERNAME && botUsernameOf(env.VITE_BOT_USERNAME) === '') {
    throw new Error(`VITE_BOT_USERNAME is not a Telegram username: «${env.VITE_BOT_USERNAME}». Expected the bot's username, with or without @.`);
  }
  // The same for the support contact: a value the app cannot turn into a link would leave «Написать в поддержку» disabled without a word.
  if (env.VITE_SUPPORT_CONTACT && supportLinkOf(env.VITE_SUPPORT_CONTACT) === '') {
    throw new Error(`VITE_SUPPORT_CONTACT is neither a Telegram username nor an https link: «${env.VITE_SUPPORT_CONTACT}».`);
  }

  // What is sold must never depend on a typo: `VITE_SUBSCRIPTIONS=of` read as «enabled» would sell what the owner switched off.
  const subscriptions = subscriptionsModeOf(env.VITE_SUBSCRIPTIONS);
  if (subscriptions === null) {
    throw new Error(`VITE_SUBSCRIPTIONS is «${env.VITE_SUBSCRIPTIONS ?? ''}». Expected ${SUBSCRIPTION_MODES.join(' or ')}, or nothing (the same as enabled).`);
  }

  // Nothing in the repository sets these for a release: they come from the environment of whoever builds.
  // A forgotten one is not an error (the app works without it), so the build says in plain words what it was given.
  if (command === 'build') {
    const support = supportLinkOf(env.VITE_SUPPORT_CONTACT);
    const bot = botUsernameOf(env.VITE_BOT_USERNAME);
    const lines = [
      `subscriptions: ${subscriptions === 'off' ? 'not sold (VITE_SUBSCRIPTIONS=off)' : 'ON SALE'}`,
      `support: ${support === '' ? 'NOT SET, the button is disabled (VITE_SUPPORT_CONTACT)' : support}`,
      `bot: ${bot === '' ? 'NOT SET, a shared chart carries no link (VITE_BOT_USERNAME)' : `@${bot}`}`,
    ];
    process.stdout.write(`${lines.map((line) => `[web build] ${line}`).join('\n')}\n`);
  }

  return {
    plugins: [
      react(),
      useMock &&
        mockApi({
          delayMs: Number(env.API_MOCK_DELAY ?? 400),
          me: env.API_MOCK_ME,
          // Empty is the same as absent: the version of the app's own texts.
          consentVersion: env.API_MOCK_CONSENT_VERSION || undefined,
          report: env.API_MOCK_REPORT,
          reportChapterMs: env.API_MOCK_REPORT_CHAPTER_MS ? Number(env.API_MOCK_REPORT_CHAPTER_MS) : undefined,
          invoice: env.API_MOCK_INVOICE,
          deletion: env.API_MOCK_DELETE,
          forecast: env.API_MOCK_FORECAST,
          pdf: env.API_MOCK_PDF === '1',
        }),
    ],
    // @astro-soul/shared is built to CommonJS. The dev server serves workspace packages as they are,
    // and a browser cannot import CommonJS, so it has to be pre-bundled like an npm dependency.
    optimizeDeps: { include: ['@astro-soul/shared'] },
    server: {
      proxy: useMock
        ? undefined
        : { '/api': { target: env.API_PROXY_TARGET ?? 'http://localhost:8080', changeOrigin: true } },
    },
    build: {
      target: BROWSER_TARGET,
      cssTarget: BROWSER_TARGET,
      sourcemap: false,
    },
    test: {
      environment: 'jsdom',
      setupFiles: ['./vitest.setup.ts'],
      css: { modules: { classNameStrategy: 'non-scoped' } },
      restoreMocks: true,
      // The SDK keeps its state in module singletons; inlining lets vi.resetModules() give a test a fresh one.
      server: { deps: { inline: [/@telegram-apps\//] } },
    },
  };
});
