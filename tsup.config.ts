import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/permission-hook.ts'],
  format: ['esm'],
  target: 'node20',
  splitting: false,
  sourcemap: false,
  clean: true,
  banner: { js: '#!/usr/bin/env node' },
});
