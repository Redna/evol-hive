import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

/**
 * Vitest config for the cli package. Aliases workspace packages to their
 * TypeScript source so tests run without a prior `pnpm build` step (same
 * pattern as `examples/vitest.config.ts`). This config lives in
 * `packages/cli`, so workspace roots are one level up (`../<pkg>`), unlike
 * the root-level `examples/vitest.config.ts` (`../packages/<pkg>`).
 */
export default defineConfig({
  resolve: {
    alias: {
      '@evol-hive/shared': resolve(__dirname, '../shared/src/index.ts'),
      '@evol-hive/engine': resolve(__dirname, '../engine/src/index.ts'),
      '@evol-hive/cognition': resolve(__dirname, '../cognition/src/index.ts'),
      '@evol-hive/memory': resolve(__dirname, '../memory/src/index.ts'),
      '@evol-hive/cli': resolve(__dirname, 'src/index.ts'),
    },
  },
});
