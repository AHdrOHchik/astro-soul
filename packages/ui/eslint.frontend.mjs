// Frontend rules for the root ESLint config: `eslint.config.mjs` spreads the
// result of frontendLayer() after the repository-wide rules, so everything
// here is an addition to them and applies to apps/web and packages/ui only.
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

const SOURCES = ['apps/web/**/*.{ts,tsx}', 'packages/ui/**/*.{ts,tsx}'];
const SCRIPTS = ['apps/web/**/*.{js,mjs}', 'packages/ui/**/*.{js,mjs}'];

/**
 * @param {typeof import('typescript-eslint').default} tseslint the instance the
 *   root config imports: a second copy of the plugin cannot be registered
 *   under the same name
 */
export function frontendLayer(tseslint) {
  return tseslint.config(
    // Generated from api.openapi.yaml; `gen:api:check` keeps it in sync instead.
    { ignores: ['apps/web/src/api/schema.gen.d.ts'] },
    {
      files: SOURCES,
      extends: [tseslint.configs.strictTypeChecked, reactHooks.configs.flat.recommended],
      rules: {
        // The strict preset resets the options set at the root; numbers stay allowed.
        '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      },
    },
    {
      // Node scripts in plain JS: no tsconfig lists them, so no type-aware rules.
      files: SCRIPTS,
      extends: [tseslint.configs.disableTypeChecked],
      languageOptions: { globals: globals.node },
    },
  );
}
