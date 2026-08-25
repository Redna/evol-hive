import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

/**
 * Vitest config for the examples package. Aliases workspace packages to their
 * TypeScript source so tests run without a prior `pnpm build` step. The source
 * files use `.js` extension imports which Vite's esbuild resolver handles via
 * `moduleResolution: bundler` semantics.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@evol-hive/shared': resolve(__dirname, '../packages/shared/src/index.ts'),
      '@evol-hive/engine': resolve(__dirname, '../packages/engine/src/index.ts'),
      '@evol-hive/cognition': resolve(__dirname, '../packages/cognition/src/index.ts'),
      '@evol-hive/memory': resolve(__dirname, '../packages/memory/src/index.ts'),
    },
  },
});
