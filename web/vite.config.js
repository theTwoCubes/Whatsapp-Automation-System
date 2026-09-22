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
      // Capacitor plugin packages are resolved at runtime by the WebView,
      // not bundled by Rollup. Add any @capacitor/* plugin used via dynamic
      // import here so the production build does not fail on missing packages.
      external: [
        '@capacitor/haptics',
      ],
    },
  },
});
