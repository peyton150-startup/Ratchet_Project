import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The consoles talk to the API by proxy so everything stays same-origin. Target defaults to the
// local API on :3000, but is overridable (e.g. VITE_PROXY_TARGET=http://api:3000 inside Docker).
const API_TARGET = process.env.VITE_PROXY_TARGET ?? 'http://localhost:3000';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: true, // bind 0.0.0.0 so the dev server is reachable from outside a container
    proxy: {
      '/graphql': { target: API_TARGET, ws: true, changeOrigin: true },
      '/events': API_TARGET,
      '/webhooks': API_TARGET,
    },
  },
});
