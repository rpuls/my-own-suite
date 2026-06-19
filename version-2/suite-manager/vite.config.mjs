import path from 'node:path';
import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const suiteManagerRoot = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  base: './',
  root: path.join(suiteManagerRoot, 'frontend'),
  plugins: [react()],
  build: {
    outDir: path.join(suiteManagerRoot, 'frontend', 'dist'),
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
