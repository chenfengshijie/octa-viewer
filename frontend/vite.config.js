import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// API base = ''：开发期由 Vite 将 /api、/data 代理到本地后端
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      '/api': 'http://localhost:8000',
      '/data': 'http://localhost:8000',
    },
  },
});
