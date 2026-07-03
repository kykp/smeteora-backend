import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'coverage/**',
      '.husky/**',
      'data/**',
      'packages/*/dist/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strict,
  ...tseslint.configs.stylistic,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      'no-console': ['error', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      // В проекте принято `type X = { ... }` вместо `interface`, для единообразия.
      // См. CLAUDE.md → секция TypeScript.
      '@typescript-eslint/consistent-type-definitions': 'off',
      // Разрешаем и `T[]` и `Array<T>` — оба валидны, зависит от читаемости.
      '@typescript-eslint/array-type': 'off',
    },
  },
  prettier,
);
