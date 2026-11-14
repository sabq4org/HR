import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { createApp } from '../../server/app.js';
import { createDatabase } from '../../server/database.js';

test('private hosting permits Railway probes only on GET/HEAD health', async () => {
  const db = await createDatabase(':memory:', { seed: false });
  const server = createServer(
    createApp(db, {
      dataMode: 'private',
      publicOrigin: 'https://private.example.test',
      accessPassword: 'synthetic-test-password-only',
    }),
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const port = address.port;
  const call = (path: string, method = 'GET', host = 'healthcheck.railway.app') =>
    new Promise<{ status: number; body: string; cookies?: string[] }>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path, method, headers: { host } }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () =>
          resolve({ status: res.statusCode!, body, cookies: res.headers['set-cookie'] }),
        );
      });
      req.on('error', reject);
      req.end();
    });
  try {
    const health = await call('/api/health');
    assert.equal(health.status, 200);
    assert.deepEqual(JSON.parse(health.body), { status: 'ok', mode: 'private-hosted' });
    assert.equal(health.cookies, undefined);
    const head = await call('/api/health', 'HEAD');
    assert.equal(head.status, 200);
    assert.equal(head.body, '');
    assert.equal(head.cookies, undefined);
    for (const path of ['/api/session', '/api/bootstrap', '/api/access', '/api/health/extra', '/'])
      assert.equal((await call(path)).status, 403, path);
    assert.equal((await call('/api/health', 'POST')).status, 403);
    assert.equal((await call('/api/health', 'GET', 'untrusted.example.test')).status, 403);
    assert.equal((await call('/api/session', 'GET', 'private.example.test')).status, 401);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await db.close();
  }
});

test('local private mode does not admit Railway hosts', async () => {
  const db = await createDatabase(':memory:', { seed: false });
  const server = createServer(createApp(db, { dataMode: 'private' }));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  try {
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(
        {
          host: '127.0.0.1',
          port: address.port,
          path: '/api/health',
          headers: { host: 'healthcheck.railway.app' },
        },
        (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode!));
        },
      );
      req.on('error', reject);
      req.end();
    });
    assert.equal(status, 403);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await db.close();
  }
});
