import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import { frontendLayer } from './packages/ui/eslint.frontend.mjs';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      '**/.venv/**',
      'packages/astro/**',
      'migrations/**',
      'api.openapi.yaml',
      // сгенерировано из контракта, руками не правим
      '**/src/contracts/generated.ts',
      // сам конфиг не входит ни в один tsconfig — линтить его нечем
      'eslint.config.mjs',
      // QA-стенд (AGENTS.md §0): отдельные .mjs-утилиты вне tsconfig всех пакетов.
      // Они не входят ни в одну сборку — как и сам конфиг выше.
      'e2e/qa/**',
      'scripts/qa/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // AGENTS.md §9: any / @ts-ignore / eslint-disable запрещены.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/ban-ts-comment': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        { allowNumber: true, allowBoolean: true },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      eqeqeq: ['error', 'always'],
      'no-console': ['error', { allow: ['error'] }],
    },
  },
  {
    // Конфиги инструментов (eslint/vitest) не типизируются — правила с типами
    // для них не работают. Объект собираем явно: правила из disableTypeChecked
    // нельзя терять, иначе плагин падает на отсутствии type-info.
    files: ['**/*.config.{js,mjs,cjs,ts}', '**/*.mjs'],
    rules: {
      ...tseslint.configs.disableTypeChecked.rules,
      'no-console': 'off',
    },
  },
  {
    files: ['**/*.spec.ts', '**/*.test.ts', 'test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
    },
  },
  // apps/web и packages/ui: слой FRONTEND поверх общих правил (strict + react-hooks).
  ...frontendLayer(tseslint),
);
