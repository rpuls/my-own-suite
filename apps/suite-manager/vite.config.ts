import { fileURLToPath } from 'node:url';
import path from 'node:path';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const rootDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: path.resolve(rootDir, 'frontend'),
  plugins: [react()],
  build: {
    outDir: path.resolve(rootDir, 'frontend', 'dist'),
    emptyOutDir: true,
  },
  server: {
    fs: {
      allow: [path.resolve(rootDir, '..', '..')],
    },
    host: '0.0.0.0',
    port: 5173,
  },
});
