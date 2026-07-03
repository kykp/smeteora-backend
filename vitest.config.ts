import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    environment: 'node',
    include: [
      'src/**/*.{test,spec}.ts',
      'packages/**/*.{test,spec}.ts',
      'test/**/*.{test,spec}.ts',
    ],
    globals: false,
    testTimeout: 30_000,
    // Интеграционные тесты бьют в общую тестовую БД. Параллельные файлы держат
    // коннекты одновременно, из-за чего TRUNCATE ловит deadlock. Гоняем в один поток.
    fileParallelism: false,
    pool: 'forks',
    poolOptions: {
      forks: { singleFork: true },
    },
  },
  resolve: {
    alias: {
      '@': resolve(here, 'src'),
      '@smeteora/shared': resolve(here, 'packages/shared/src/index.ts'),
    },
  },
});
