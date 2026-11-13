import { createServer } from 'node:http';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import express from 'express';
import { createApp } from './app.js';
import { createDatabase } from './database.js';

const envFile = resolve('.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const production = process.env.NODE_ENV === 'production';
if (production && process.env.LOCAL_DEMO !== 'true') {
  throw new Error('Refusing to start synthetic demo mode in production without LOCAL_DEMO=true');
}

const defaultDataDir = resolve('.data');
mkdirSync(defaultDataDir, { recursive: true });
const app = createApp(
  createDatabase(process.env.HR_DB_PATH ?? resolve(defaultDataDir, 'hr-local.sqlite')),
);
if (production) {
  app.use(express.static(resolve('dist/client')));
  app.get('/{*path}', (_req, res) => res.sendFile(resolve('dist/client/index.html')));
} else {
  const { createServer: createViteServer } = await import('vite');
  const vite = await createViteServer({ server: { middlewareMode: true }, appType: 'spa' });
  app.use(vite.middlewares);
}

const port = Number(process.env.PORT ?? 4317);
const server = createServer(app);
server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`Sabq HR synthetic local app listening at http://127.0.0.1:${port}\n`);
});
