import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

/**
 * Vitest config for the assembly package. Aliases workspace packages to their
 * TypeScript source so tests run without a prior `pnpm build` step (same
 * pattern as `examples/vitest.config.ts`). This config lives in
 * `packages/assembly`, so workspace roots are one level up (`../<pkg>`).
 */
export default defineConfig({
  resolve: {
    alias: {
      '@evol-hive/shared': resolve(__dirname, '../shared/src/index.ts'),
      '@evol-hive/engine': resolve(__dirname, '../engine/src/index.ts'),
      '@evol-hive/cognition': resolve(__dirname, '../cognition/src/index.ts'),
      '@evol-hive/memory': resolve(__dirname, '../memory/src/index.ts'),
      '@evol-hive/assembly': resolve(__dirname, 'src/index.ts'),
    },
  },
});