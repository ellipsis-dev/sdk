// The npm build: plain ESM + type declarations for the three subpath entries.
// Workspace consumers (frontend/admin via transpilePackages) keep importing
// the TS source; `dist/` exists only for the published artifact (see
// scripts/prepare-publish.mjs) and must stay dependency-free ESM so the CLI's
// Bun --compile can bundle it.
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'stream/index': 'src/stream/index.ts',
    'store/index': 'src/store/index.ts',
  },
  format: ['esm'],
  dts: true,
  sourcemap: false,
  clean: true,
  outDir: 'dist',
});
