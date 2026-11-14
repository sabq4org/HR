import { createServer } from 'node:http';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import express from 'express';
import { createApp } from './app.js';
import { createDatabase, createPostgresDatabase } from './database.js';
import { createHostedDemoApp } from './hosted-demo.js';
import { verifyDataKeyBinding } from './data-key.js';
import { resolveRuntimeConfig } from './runtime-config.js';
import { pageCsp } from './http-hardening.js';

const envFile = resolve('.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const config = resolveRuntimeConfig(process.env);
const production = process.env.NODE_ENV === 'production';
const hostedDemo = config.mode === 'hosted-demo';
const privateHosted = config.mode === 'private-hosted';
const privateData = config.mode === 'private-local';
const runtime =
  config.mode === 'private-hosted'
    ? await (async () => {
        const db = await createPostgresDatabase(config.databaseUrl, 'hr_private', {
          seed: false,
        });
        try {
          await verifyDataKeyBinding(db);
        } catch (error) {
          await db.close();
          throw error;
        }
        return {
          app: createApp(db, {
            dataMode: 'private',
            publicOrigin: config.publicOrigin,
            accessPassword: config.accessPassword,
            trustProxyHops: config.trustProxyHops,
            financeEmployeeId: process.env.HR_FINANCE_EMPLOYEE_ID,
          }),
          close: () => db.close(),
        };
      })()
    : config.mode === 'hosted-demo'
      ? await createHostedDemoApp({
          publicOrigin: config.publicOrigin,
          databaseUrl: config.previewDatabaseUrl,
        })
      : await (async () => {
          const defaultDataDir = resolve('.data');
          mkdirSync(defaultDataDir, { recursive: true });
          const db =
            config.mode === 'private-local'
              ? await createDatabase(
                  config.dbPath ?? resolve(defaultDataDir, 'hr-private.sqlite'),
                  {
                    seed: false,
                  },
                )
              : config.driver === 'postgres'
                ? await createPostgresDatabase(config.databaseUrl ?? '', 'hr_development')
                : await createDatabase(config.dbPath ?? resolve(defaultDataDir, 'hr-local.sqlite'));
          if (config.mode === 'private-local') {
            try {
              await verifyDataKeyBinding(db);
            } catch (error) {
              await db.close();
              throw error;
            }
          }
          return {
            app: createApp(db, {
              dataMode: privateData ? 'private' : 'synthetic',
              financeEmployeeId: privateData ? process.env.HR_FINANCE_EMPLOYEE_ID : undefined,
            }),
            close: () => db.close(),
          };
        })();
const { app } = runtime;
// Security headers are applied inside createApp/createHostedDemoApp, before any route,
// so API responses carry them too (second review, note 11).
if (production) {
  app.use(pageCsp);
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

const port = Number(process.env.PORT ?? 4317);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT.');
const server = createServer(app);
const host = hostedDemo || privateHosted ? '0.0.0.0' : '127.0.0.1';
server.listen(port, host, () => {
  process.stdout.write(
    `Sabq HR ${privateHosted ? 'PRIVATE hosted (password gate)' : privateData ? 'PRIVATE (real data, this machine only)' : hostedDemo ? 'synthetic hosted' : 'synthetic local'} app listening on ${host}:${port}\n`,
  );
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
