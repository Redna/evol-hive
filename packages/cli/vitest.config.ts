import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      '@evol-hive/shared': resolve(__dirname, '../packages/shared/src/index.ts'),
      '@evol-hive/engine': resolve(__dirname, '../packages/engine/src/index.ts'),
      '@evol-hive/cognition': resolve(__dirname, '../packages/cognition/src/index.ts'),
      '@evol-hive/memory': resolve(__dirname, '../packages/memory/src/index.ts'),
      '@evol-hive/cli': resolve(__dirname, 'src/index.ts'),
    },
  },
});