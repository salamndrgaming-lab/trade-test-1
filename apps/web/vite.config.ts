import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // `pnpm dev`: the dashboard reads the local bot through this proxy (no CORS needed)
  server: { host: true, port: 5173, proxy: { '/state': 'http://127.0.0.1:8787', '/health': 'http://127.0.0.1:8787' } },
  preview: { host: true, port: 4173 },
  build: { target: 'es2022', sourcemap: true },
});
