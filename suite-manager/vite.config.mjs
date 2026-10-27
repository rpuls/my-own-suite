import path from 'node:path';
import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const suiteManagerRoot = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  base: '/suite-manager/assets/',
  root: path.join(suiteManagerRoot, 'frontend'),
  plugins: [react()],
  build: {
    // Beside the served pages; Suite Manager swaps them in as it starts (frontend-release.cjs).
    outDir: path.join(suiteManagerRoot, 'frontend', 'dist-next'),
    emptyOutDir: true,
  },
  server: {
    fs: {
      allow: [path.resolve(suiteManagerRoot, '..')],
    },
    host: '0.0.0.0',
    port: 5174,
  },
});
