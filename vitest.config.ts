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
  },
  resolve: {
    alias: {
      '@': resolve(here, 'src'),
      '@smeteora/shared': resolve(here, 'packages/shared/src/index.ts'),
    },
  },
});
