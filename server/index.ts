import { createServer } from 'node:http';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import express from 'express';
import { createApp } from './app.js';
import { createDatabase } from './database.js';
import { createHostedDemoApp } from './hosted-demo.js';

const envFile = resolve('.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const production = process.env.NODE_ENV === 'production';
const hostedDemo = process.env.HR_MODE === 'hosted-demo';
if (process.env.HR_MODE && !hostedDemo) {
  throw new Error('Unsupported HR_MODE. Only hosted-demo is available for public previews.');
}
if (hostedDemo && !production) throw new Error('Hosted previews require NODE_ENV=production.');
if (production && !hostedDemo && process.env.LOCAL_DEMO !== 'true') {
  throw new Error('Select HR_MODE=hosted-demo or explicitly enable LOCAL_DEMO=true.');
}
if (hostedDemo && process.env.HR_DB_PATH) {
  throw new Error('Hosted previews use isolated temporary databases; HR_DB_PATH is not allowed.');
}
const runtime = hostedDemo
  ? createHostedDemoApp({ publicOrigin: process.env.HR_PUBLIC_ORIGIN ?? '' })
  : (() => {
      const defaultDataDir = resolve('.data');
      mkdirSync(defaultDataDir, { recursive: true });
      const db = createDatabase(
        process.env.HR_DB_PATH ?? resolve(defaultDataDir, 'hr-local.sqlite'),
      );
      return { app: createApp(db), close: () => db.close() };
    })();
const { app } = runtime;
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  if (hostedDemo) res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  next();
});
if (production) {
  app.use(express.static(resolve('dist/client'), { index: false }));
  app.get('/{*path}', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(resolve('dist/client/index.html'));
  });
} else {
  const { createServer: createViteServer } = await import('vite');
  const vite = await createViteServer({ server: { middlewareMode: true }, appType: 'spa' });
  app.use(vite.middlewares);
}

const port = Number(process.env.PORT ?? 4317);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT.');
const server = createServer(app);
const host = hostedDemo ? '0.0.0.0' : '127.0.0.1';
server.listen(port, host, () => {
  process.stdout.write(
    `Sabq HR synthetic ${hostedDemo ? 'hosted' : 'local'} app listening on ${host}:${port}\n`,
  );
});
let stopping = false;
function shutdown() {
  if (stopping) return;
  stopping = true;
  server.close(() => {
    runtime.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
