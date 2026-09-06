import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

/**
 * Vitest config for the visualizer package. Aliases `@evol-hive/shared` to
 * its TypeScript source so tests run without a prior `pnpm build` step.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@evol-hive/shared': resolve(__dirname, '../shared/src/index.ts'),
    },
  },
});
