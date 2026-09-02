import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { execSync } from 'child_process';
import { readFileSync } from 'fs';

// In dev the console runs on vite and proxies api calls to the node server.
// In production the node server serves the built files from web/dist.

function getBuildInfo() {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)));
  let gitSha = 'dev';
  try { gitSha = execSync('git rev-parse --short HEAD').toString().trim(); } catch { /* no git */ }
  return {
    version: pkg.version || '0.0.0',
    gitSha,
    buildTime: new Date().toISOString(),
  };
}

export default defineConfig({
  plugins: [react()],
  define: {
    __BUILD_INFO__: JSON.stringify(getBuildInfo()),
  },
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
