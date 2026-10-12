import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node20',
  splitting: false,
  sourcemap: false,
  clean: true,
  // Guides (src/guides/*.md) are bundled as strings, so the one copy ships inside dist/.
  loader: { '.md': 'text' },
  banner: { js: '#!/usr/bin/env node' },
});
