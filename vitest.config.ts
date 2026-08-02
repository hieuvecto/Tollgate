import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      '@tollgate/shared': fileURLToPath(new URL('./packages/shared/src/index.ts', import.meta.url)),
      '@tollgate/db': fileURLToPath(new URL('./packages/db/src/index.ts', import.meta.url)),
    },
  },
  test: { include: ['tests/**/*.test.ts'], testTimeout: 30_000, hookTimeout: 30_000 },
});
