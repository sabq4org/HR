import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { darkThemePlugin } from './scripts/dark-theme-css';

const stylesheets = (readdirSync('src', { recursive: true }) as string[])
  .filter((file) => file.endsWith('.css'))
  .map((file) => readFileSync(join('src', file), 'utf8'));

export default defineConfig({
  plugins: [react()],
  // Emits the dark-mode twin of every colour rule at build time (decision 018).
  css: { postcss: { plugins: [darkThemePlugin(stylesheets)] } },
  build: { outDir: 'dist/client', emptyOutDir: true },
  server: { host: '127.0.0.1', allowedHosts: ['localhost', '127.0.0.1'] },
});
