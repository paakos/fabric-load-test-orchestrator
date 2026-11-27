import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { helpPlugin } from './tools/help-plugin.ts';

// Rayfin writes VITE_PORT to .env.local and registers that origin in the backend: the port must not change silently.
export default defineConfig(({ mode }) => {
  const port = Number(loadEnv(mode, process.cwd(), 'VITE_').VITE_PORT) || 5173;
  return {
    plugins: [react(), helpPlugin()],
    build: {
      outDir: 'dist',
      target: 'es2022',
      chunkSizeWarningLimit: 1200,
      // blank.html: MSAL sign-in return. popup-relay.html: sign-in from the iframe of the Fabric portal.
      rollupOptions: { input: { main: 'index.html', blank: 'blank.html', relay: 'popup-relay.html' } },
    },
    server: { port, strictPort: true, host: 'localhost' },
    preview: { port, strictPort: true, host: 'localhost' },
    test: { environment: 'jsdom', include: ['src/**/*.test.ts', 'src/**/*.test.tsx'], testTimeout: 30000 },
  };
});
