import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * The dashboard is served as static files by the hub itself in production, so
 * the build is plain and relative-free. In development `npm run dev:web`
 * proxies the API and the WebSocket to a hub running on port 8080.
 */
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:8080', changeOrigin: true },
      '/ws': { target: 'ws://localhost:8080', ws: true },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // A Pi 4 serves this over wifi to a tablet; keep the bundle honest.
    chunkSizeWarningLimit: 400,
  },
});
