import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// The backend serves the built files itself. During development Vite serves
// the pages and passes API calls on to the backend.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { '/api': 'http://127.0.0.1:8765' },
  },
  build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 1500 },
  test: { include: ['src/**/*.test.ts'], environment: 'node' },
});
