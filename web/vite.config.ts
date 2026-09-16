import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The frontend talks to the backend only through /api, so it can be built here
// and served either by the backend itself (default) or by any static host.
// During development the dev server proxies /api to the backend, which keeps
// the browser same-origin and therefore identical to production.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // `shared/schema.ts` lives above this root and is imported by both the
    // frontend and the backend, so the dev server must be allowed to read it.
    fs: { allow: ['..'] },
    proxy: {
      // Where the backend listens. Change this if you run the API elsewhere;
      // proxying keeps the browser same-origin, so dev matches production.
      '/api': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: true,
        ws: false,
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    // The bundle is ~307 kB gzipped, almost all of it antd + React. That is
    // normal for a component-library admin UI and irrelevant on an intranet, so
    // the default 500 kB warning is raised rather than worked around:
    // `manualChunks` is not supported by Vite 8's rolldown bundler, and an
    // intranet dashboard is loaded once per session anyway.
    chunkSizeWarningLimit: 1200,
  },
});
