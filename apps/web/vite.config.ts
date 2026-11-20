import react from '@vitejs/plugin-react';
import { loadEnv } from 'vite';
import { defineConfig } from 'vitest/config';
import { mockApi } from './mock/plugin.ts';
import { readBuildSettings } from './scripts/buildSettings.ts';

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
  // A value nobody can read stops the dev server and the build alike: taken for «not set», it would be a
  // release that quietly differs from what the owner meant (a bot's name with a typo, `VITE_SUBSCRIPTIONS=of`).
  const settings = readBuildSettings(env);
  // Nothing in the repository sets these values for a release, so a build says what it was given. `pnpm build`
  // has said it already, as its very first step (scripts/print-build-settings.ts); a bare `vite build` says it here.
  if (command === 'build' && env.WEB_BUILD_SETTINGS_SHOWN !== '1') {
    process.stdout.write(`${settings.lines.join('\n')}\n`);
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
      allowedHosts: ['.e2b.app'],
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
