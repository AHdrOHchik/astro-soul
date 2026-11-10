// Shared ESLint preset for the frontend packages (apps/web, packages/ui).
import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/** @param {string} tsconfigRootDir absolute path of the package being linted */
export function frontendConfig(tsconfigRootDir) {
  return defineConfig(
    { ignores: ['dist/**', 'coverage/**', '**/*.gen.d.ts'] },
    js.configs.recommended,
    {
      files: ['**/*.{ts,tsx}'],
      extends: [tseslint.configs.strictTypeChecked, reactHooks.configs.flat.recommended],
      languageOptions: {
        globals: globals.browser,
        parserOptions: { projectService: true, tsconfigRootDir },
      },
      rules: {
        '@typescript-eslint/consistent-type-imports': 'error',
        '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
        'no-console': ['error', { allow: ['warn', 'error'] }],
        eqeqeq: ['error', 'always', { null: 'ignore' }],
      },
    },
    {
      files: ['**/*.{js,mjs}', '*.config.ts', 'mock/**/*.ts', 'scripts/**'],
      languageOptions: { globals: globals.node },
      rules: { 'no-console': 'off' },
    },
  );
}
