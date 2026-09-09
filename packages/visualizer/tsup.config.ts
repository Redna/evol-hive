import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  treeshake: true,
  // The server's client-bundle helper calls esbuild's build API at runtime —
  // keep it external so the dist bundle imports the installed esbuild instead
  // of inlining its CJS API into this ESM output ("Dynamic require of fs").
  external: ['esbuild'],
});
