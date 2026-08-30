import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In dev the console runs on vite and proxies api calls to the node server.
// In production the node server serves the built files from web/dist.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': { target: 'http://localhost:3000', ws: true },
      '/health': 'http://localhost:3000',
    },
  },
  build: {
    outDir: 'dist',
    rollupOptions: {
      // Capacitor plugins are only present inside the Android APK bundle,
      // not the plain browser build. Marking them external lets Rollup skip
      // resolving them and leaves the dynamic import as a runtime no-op in
      // the browser (which is exactly what push.js wants).
      external: [/^@capacitor\//],
    },
  },
});
