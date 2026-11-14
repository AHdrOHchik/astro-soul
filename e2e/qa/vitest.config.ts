import { defineConfig } from 'vitest/config';
import { join } from 'node:path';

/**
 * QA-002: конфиг vitest для проверок вне тестов фронта (задача 3.2).
 *
 * Живёт в `e2e/qa/`, не касается `apps/web/vitest.config.ts` (у фронта свои
 * тесты, AGENTS.md §0). Условия те же, что у приложения: jsdom,
 * `classNameStrategy: 'non-scoped'`, тот же setup-файл.
 *
 * `resolve.alias` не косметика: файл теста лежит в `e2e/qa/`, а `node_modules`
 * с этими пакетами — в `apps/web`, поэтому без явных путей Vite не находит ни
 * `@testing-library/react`, ни `react/jsx-dev-runtime`.
 */
const WEB = join(import.meta.dirname, '../../apps/web');
const webModules = join(WEB, 'node_modules');

export default defineConfig({
  root: WEB,
  resolve: {
    alias: [
      { find: /^react\/jsx-dev-runtime$/, replacement: join(webModules, 'react/jsx-dev-runtime.js') },
      { find: /^react\/jsx-runtime$/, replacement: join(webModules, 'react/jsx-runtime.js') },
      { find: /^react$/, replacement: join(webModules, 'react/index.js') },
      { find: /^react-dom\/client$/, replacement: join(webModules, 'react-dom/client.js') },
      { find: /^react-dom$/, replacement: join(webModules, 'react-dom/index.js') },
      { find: /^@testing-library\/react$/, replacement: join(webModules, '@testing-library/react/dist/index.js') },
      { find: /^@testing-library\/dom$/, replacement: join(webModules, '@testing-library/dom/dist/index.js') },
      { find: /^@astro-soul\/ui$/, replacement: join(WEB, '../../packages/ui/src/index.ts') },
      { find: /^@astro-soul\/shared$/, replacement: join(WEB, '../../packages/shared/src/index.ts') },
    ],
  },
  test: {
    environment: 'jsdom',
    include: ['../../e2e/qa/**/*.qa.test.tsx', '../../e2e/qa/**/*.qa.test.ts'],
    setupFiles: [join(WEB, 'vitest.setup.ts')],
    css: { modules: { classNameStrategy: 'non-scoped' } },
    restoreMocks: true,
    server: { deps: { inline: [/@telegram-apps\//] } },
  },
});
