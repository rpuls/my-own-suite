import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { fileURLToPath, URL } from 'node:url';

// The planner deploys as a static sub-app of the MOS site at /plan/. The dev
// server stays at / so absolute /brand/... font and favicon URLs resolve
// against the local public/ copies that prepare-assets.mjs puts in place.
export default defineConfig(({ command, isPreview }) => ({
  base: command === 'build' || isPreview ? '/plan/' : '/',
  plugins: [react()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  // The bundle imports the synced brand stylesheet from site/generated/.
  server: { fs: { allow: ['..'] } },
  build: {
    target: 'es2020',
    outDir: '../dist/plan',
    emptyOutDir: true,
  },
}));
