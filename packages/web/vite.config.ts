import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // The consoles talk to the API on :3000; proxying keeps everything same-origin in dev.
    proxy: {
      '/graphql': { target: 'http://localhost:3000', ws: true, changeOrigin: true },
      '/events': 'http://localhost:3000',
      '/webhooks': 'http://localhost:3000',
    },
  },
});
