import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { fileURLToPath, URL } from 'node:url';

// The planner deploys as a static sub-app of the MOS site at /plan/, and serves
// from /plan/ in dev too, so `npm run dev` in site/ can proxy that path straight
// through to this server (see astro.config.mjs) and both modes exercise the same
// URLs. Running this server on its own therefore serves
// http://127.0.0.1:5173/plan/.
export default defineConfig({
  base: '/plan/',
  plugins: [
    react(),
    {
      // Site-root brand URLs (/brand/... in JSX and in the synced mos.css) are
      // served by the Astro site in dev and by the deployed site in production.
      // Standalone, map them onto the planner's own staged copy.
      name: 'planner-dev-site-paths',
      apply: 'serve',
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          // Site-root brand URLs (/brand/... in JSX and in the synced mos.css)
          // are served by the Astro site in dev and by the deployed site in
          // production. Standalone, map them onto the planner's staged copy.
          if (req.url?.startsWith('/brand/')) req.url = `/plan${req.url}`;
          // Match the deployed site's directory redirect, so a typed /plan
          // lands on the app instead of Vite's base-mismatch 404.
          const [pathname, query] = (req.url ?? '').split('?');
          if (pathname === '/plan') {
            res.writeHead(301, { Location: query ? `/plan/?${query}` : '/plan/' });
            res.end();
            return;
          }
          next();
        });
      },
    },
  ],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  // The bundle imports the synced brand stylesheet from site/generated/.
  server: { fs: { allow: ['..'] }, port: 5173, strictPort: true },
  build: {
    target: 'es2020',
    outDir: '../dist/plan',
    emptyOutDir: true,
  },
});
