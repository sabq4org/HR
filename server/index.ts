import { createServer } from 'node:http';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import express from 'express';
import { createApp } from './app.js';
import { createDatabase, createPostgresDatabase } from './database.js';
import { createHostedDemoApp } from './hosted-demo.js';
import { readRuntimeConfig } from './runtime-config.js';
import { startOperations } from './operations/index.js';

const envFile = resolve('.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const config = readRuntimeConfig();
const { production } = config;
const hostedDemo = config.mode === 'hosted-demo';
const operational = config.mode === 'operational';
const runtime = hostedDemo
  ? await createHostedDemoApp({
      publicOrigin: config.publicOrigin ?? '',
      databaseUrl: config.databaseUrl,
    })
  : await (async () => {
      const defaultDataDir = resolve('.data');
      mkdirSync(defaultDataDir, { recursive: true });
      const db =
        config.driver === 'postgres'
          ? await createPostgresDatabase(config.databaseUrl ?? '', config.schema, {
              seed: config.seed,
            })
          : await createDatabase(config.databasePath, { seed: config.seed });
      if (
        operational &&
        !config.seed &&
        (
          await db.read(
            "SELECT id FROM employees WHERE id IN ('emp-noura','emp-omar','emp-sara') LIMIT 1",
          )
        ).length
      ) {
        await db.close();
        throw new Error(
          'Operational storage contains demo fixtures. Select a separate database; no data was removed.',
        );
      }
      const jobs = operational ? startOperations(db) : undefined;
      return {
        app: createApp(db, {
          authMode: operational ? 'accounts' : 'demo',
          publicOrigin: config.publicOrigin,
        }),
        close: async () => {
          await jobs?.close();
          await db.close();
        },
      };
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

const { port, host } = config;
const server = createServer(app);
server.listen(port, host, () => {
  process.stdout.write(`Sabq HR ${config.mode} app listening on ${host}:${port}\n`);
});
let stopping = false;
function shutdown() {
  if (stopping) return;
  stopping = true;
  server.close(() => {
    void runtime.close().finally(() => process.exit(0));
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
