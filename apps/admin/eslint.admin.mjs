// Rules for the admin panel: the same strict layer `apps/web` gets from
// packages/ui/eslint.frontend.mjs, but with its own globs. The shared layer is
// not edited (packages/* belongs to FRONTEND, AGENTS.md §0), and admin cannot
// be linted weaker: it is the app that changes prices and revokes access.
//
// The factory takes the `tseslint` instance the root config imports, exactly
// like frontendLayer does: a second copy of the plugin cannot be registered
// under the same name.
import reactHooks from 'eslint-plugin-react-hooks';

const SOURCES = ['apps/admin/**/*.{ts,tsx}'];

/**
 * @param {typeof import('typescript-eslint').default} tseslint the instance the
 *   root config imports
 * @returns {import('eslint').Linter.Config[]}
 */
export function adminLayer(tseslint) {
  return tseslint.config(
    // Generated from api.openapi.yaml; `gen:api:check` keeps it in sync instead.
    { ignores: ['apps/admin/src/api/schema.gen.d.ts', 'apps/admin/dist/**'] },
    {
      files: SOURCES,
      extends: [tseslint.configs.strictTypeChecked, reactHooks.configs.flat.recommended],
      rules: {
        // The strict preset resets the options set at the root; numbers stay allowed.
        '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
        // `warn` is the channel for a developer-only signal, e.g. the mock notice.
        'no-console': ['error', { allow: ['error', 'warn'] }],
      },
    },
  );
}
