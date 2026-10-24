import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = dirname(fileURLToPath(import.meta.url));

// Two separate entry points: the customer app (index.html) and the admin portal (admin.html).
// The customer bundle contains no admin code at all.
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: { '/api': 'http://localhost:3000' } },
  build: { rollupOptions: { input: { main: resolve(root, 'index.html'), admin: resolve(root, 'admin.html') } } },
});
