import { createServer } from 'node:http';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import express from 'express';
import { createApp } from './app.js';
import { createDatabase, createPostgresDatabase } from './database.js';
import { createHostedDemoApp } from './hosted-demo.js';
import { parseServiceKeyHashes } from './finance/service-keys.js';
import { startOperations } from './operations/index.js';
import { readRuntimeConfig } from './runtime-config.js';

const envFile = resolve('.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const config = readRuntimeConfig();
const hostedDemo = config.mode === 'hosted-demo';
const privateHosted = config.mode === 'private-hosted';
const operational = config.mode === 'operational';
const privateLocal = config.mode === 'private-local';
const financeApiKeyHashes = parseServiceKeyHashes(process.env.HR_FINANCE_API_KEY_HASHES);
if (financeApiKeyHashes.length && !['private-local', 'private-hosted'].includes(config.mode))
  throw new Error(
    'HR_FINANCE_API_KEY_HASHES applies only to private-local and private-hosted modes.',
  );
const runtime = hostedDemo
  ? await createHostedDemoApp({
      publicOrigin: config.publicOrigin ?? '',
      databaseUrl: config.databaseUrl,
    })
  : await (async () => {
      mkdirSync(resolve('.data'), { recursive: true });
      const db = await (config.driver === 'postgres'
        ? createPostgresDatabase(config.databaseUrl ?? '', config.schema, { seed: config.seed })
        : createDatabase(config.databasePath, { seed: config.seed }));
      if ((operational || privateLocal || privateHosted) && !config.seed) {
        const synthetic = await db.read(
          "SELECT id FROM employees WHERE id IN ('emp-noura','emp-omar','emp-sara') LIMIT 1",
        );
        if (synthetic.length) {
          await db.close();
          throw new Error(
            'Private storage contains demo fixtures. Select a separate database; no data was removed.',
          );
        }
      }
      const jobs = operational ? startOperations(db) : undefined;
      return {
        app: createApp(db, {
          dataMode: config.dataMode,
          authMode: operational ? 'accounts' : 'demo',
          publicOrigin: config.publicOrigin,
          accessPassword: config.accessPassword,
          financeEmployeeId:
            config.dataMode === 'private' && !operational
              ? process.env.HR_FINANCE_EMPLOYEE_ID
              : undefined,
          financeApiKeyHashes:
            !operational && config.dataMode === 'private' ? financeApiKeyHashes : undefined,
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
  if (hostedDemo || privateHosted) res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  next();
});
if (config.production) {
  app.use(express.static(resolve('dist/client'), { index: false }));
  app.get('/{*path}', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile('index.html', { root: resolve('dist/client') });
  });
} else {
  const { createServer: createViteServer } = await import('vite');
  const vite = await createViteServer({ server: { middlewareMode: true }, appType: 'spa' });
  app.use(vite.middlewares);
}
const server = createServer(app);
server.listen(config.port, config.host, () => {
  process.stdout.write(`Sabq HR ${config.mode} app listening on ${config.host}:${config.port}\n`);
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
