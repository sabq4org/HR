// Regression tests for the second independent review (2026-11-14), notes 1, 3, 5, 9, 11.
// Each test fails on commit 35876ac and passes with the fix.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createApp } from '../../server/app.js';
import { createDatabase } from '../../server/database.js';

const keyA = randomBytes(32).toString('base64url');
const keyB = randomBytes(32).toString('base64url');
process.env.HR_DATA_KEY = keyA;

async function listen(app: ReturnType<typeof createApp>) {
  const server: Server = createServer(app);
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return { server, port: address.port };
}
function call(
  port: number,
  path: string,
  init: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
) {
  return new Promise<{ status: number; body: string; headers: Record<string, unknown> }>(
    (done, fail) => {
      const payload = init.body === undefined ? undefined : JSON.stringify(init.body);
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port,
          path,
          method: init.method ?? 'GET',
          headers: {
            ...(payload ? { 'content-type': 'application/json' } : {}),
            ...init.headers,
          },
        },
        (res) => {
          let body = '';
          res.on('data', (chunk) => (body += chunk));
          res.on('end', () => done({ status: res.statusCode!, body, headers: res.headers }));
        },
      );
      req.on('error', fail);
      req.end(payload);
    },
  );
}

// Note 3: ten wrong passwords from anyone used to lock the gate for everyone.
test('access gate locks only the client that failed, not the owner', async () => {
  const db = await createDatabase(':memory:', { seed: false });
  const origin = 'https://hr.example.test';
  const password = 'correct-horse-battery';
  const { server, port } = await listen(
    createApp(db, {
      dataMode: 'private',
      publicOrigin: origin,
      accessPassword: password,
      trustProxyHops: 1,
    }),
  );
  // Railway's proxy appends the real client address as the rightmost X-Forwarded-For entry.
  const attempt = (clientIp: string, value: string, claimed?: string) =>
    call(port, '/api/access', {
      method: 'POST',
      body: { password: value },
      headers: {
        host: 'hr.example.test',
        origin,
        'x-forwarded-for': claimed ? `${claimed}, ${clientIp}` : clientIp,
      },
    });
  try {
    for (let i = 0; i < 10; i++)
      assert.equal((await attempt('203.0.113.9', `wrong-${i}`)).status, 401);
    const attacker = await attempt('203.0.113.9', password);
    assert.equal(attacker.status, 429, 'the failing client stays locked');
    assert.ok(Number(attacker.headers['retry-after']) > 0);
    // A spoofed leftmost entry does not let the attacker escape its own counter.
    assert.equal((await attempt('203.0.113.9', password, '198.51.100.1')).status, 429);
    const owner = await attempt('198.51.100.7', password);
    assert.equal(owner.status, 200, 'the owner still signs in from another address');
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
    await db.close();
  }
});

test('without a trusted proxy, forwarded headers cannot reset the counter', async () => {
  const db = await createDatabase(':memory:', { seed: false });
  const origin = 'https://hr.example.test';
  const { server, port } = await listen(
    createApp(db, { dataMode: 'private', publicOrigin: origin, accessPassword: 'x'.repeat(16) }),
  );
  try {
    for (let i = 0; i < 10; i++)
      await call(port, '/api/access', {
        method: 'POST',
        body: { password: 'wrong' },
        headers: { host: 'hr.example.test', origin, 'x-forwarded-for': `192.0.2.${i}` },
      });
    const next = await call(port, '/api/access', {
      method: 'POST',
      body: { password: 'x'.repeat(16) },
      headers: { host: 'hr.example.test', origin, 'x-forwarded-for': '192.0.2.200' },
    });
    assert.equal(next.status, 429);
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
    await db.close();
  }
});

// Note 1: the public synthetic preview silently used DATABASE_URL (the real database).
test('the public preview refuses to start with any private-service variable', async () => {
  const { resolveRuntimeConfig } = await import('../../server/runtime-config.js');
  const base = {
    NODE_ENV: 'production',
    HR_MODE: 'hosted-demo',
    HR_PUBLIC_ORIGIN: 'https://preview.example.test',
  };
  assert.deepEqual(resolveRuntimeConfig(base), {
    mode: 'hosted-demo',
    publicOrigin: 'https://preview.example.test',
  });
  for (const [name, value] of [
    ['DATABASE_URL', 'postgres://user:secret@db.example.test/hr'],
    ['HR_PRIVATE_DATABASE_URL', 'postgres://user:secret@db.example.test/hr'],
    ['HR_DATA_KEY', keyA],
    ['HR_ACCESS_PASSWORD', 'correct-horse-battery'],
  ] as const) {
    assert.throws(
      () => resolveRuntimeConfig({ ...base, [name]: value }),
      (error: Error) => error.message.includes(`remove ${name}`) && !error.message.includes(value),
      name,
    );
  }
  // A PostgreSQL preview is still possible, but only by a separate, explicit variable.
  assert.equal(
    (
      resolveRuntimeConfig({
        ...base,
        HR_PREVIEW_DATABASE_URL: 'postgres://preview@other.example.test/preview',
      }) as { previewDatabaseUrl?: string }
    ).previewDatabaseUrl,
    'postgres://preview@other.example.test/preview',
  );
  assert.throws(
    () =>
      resolveRuntimeConfig({
        NODE_ENV: 'production',
        HR_MODE: 'private-hosted',
        DATABASE_URL: 'postgres://x@y/z',
        HR_PUBLIC_ORIGIN: 'https://private.example.test',
        HR_DATA_KEY: keyA,
        HR_ACCESS_PASSWORD: 'correct-horse-battery',
        HR_PREVIEW_DATABASE_URL: 'postgres://x@y/z',
      }),
    /public preview database/,
  );
});

test('the server process exits before connecting when the preview carries DATABASE_URL', async () => {
  const child = spawn(process.execPath, ['--import', 'tsx', resolve('server/index.ts')], {
    env: {
      PATH: process.env.PATH,
      NODE_ENV: 'production',
      HR_MODE: 'hosted-demo',
      HR_PUBLIC_ORIGIN: 'https://preview.example.test',
      // Unroutable on purpose: a connection attempt would hang or fail differently.
      DATABASE_URL: 'postgres://nobody:nothing@192.0.2.1:5432/none?connect_timeout=2',
      PORT: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => (output += chunk));
  child.stderr.on('data', (chunk) => (output += chunk));
  const code = await new Promise<number | null>((done) => {
    const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
    child.on('exit', (exitCode) => {
      clearTimeout(timer);
      done(exitCode);
    });
  });
  assert.notEqual(code, 0);
  assert.match(output, /hosted-demo is public and synthetic; remove DATABASE_URL/);
  assert.doesNotMatch(output, /nothing@/, 'the connection string is never echoed');
  assert.doesNotMatch(output, /listening/);
});

test('a malformed HR_DATA_KEY stops startup instead of failing on first use', async () => {
  const { resolveRuntimeConfig } = await import('../../server/runtime-config.js');
  const env = {
    NODE_ENV: 'production',
    HR_MODE: 'private-hosted',
    DATABASE_URL: 'postgres://x@y/z',
    HR_PUBLIC_ORIGIN: 'https://private.example.test',
    HR_ACCESS_PASSWORD: 'correct-horse-battery',
  };
  assert.equal(resolveRuntimeConfig({ ...env, HR_DATA_KEY: keyA }).mode, 'private-hosted');
  for (const bad of ['short', `${keyA}AA`, 'x'.repeat(43)])
    assert.throws(
      () => resolveRuntimeConfig({ ...env, HR_DATA_KEY: bad }),
      (error: Error) => /32-byte base64url/.test(error.message) && !error.message.includes(bad),
    );
});

// Note 5: a different key in the import tool or the service went unnoticed.
test('a database is bound to its data key and refuses a different one', async () => {
  const { verifyDataKeyBinding } = await import('../../server/data-key.js');
  process.env.HR_DATA_KEY = keyA;
  const db = await createDatabase(':memory:'); // seeded profiles are encrypted with key A
  try {
    const encrypted = await db.read<{ n: number }>(
      "SELECT count(*) AS n FROM employee_profile_data WHERE encrypted_values_json<>'{}'",
    );
    assert.ok(encrypted[0].n > 0, 'fixture has encrypted samples');
    assert.equal(await verifyDataKeyBinding(db), 'bound');
    assert.equal(await verifyDataKeyBinding(db), 'verified');
    const [row] = await db.read<{ fingerprint: string }>(
      'SELECT fingerprint FROM data_key_binding',
    );
    assert.match(row.fingerprint, /^[0-9a-f]{64}$/);
    assert.ok(!row.fingerprint.includes(Buffer.from(keyA, 'base64url').toString('hex')));
    process.env.HR_DATA_KEY = keyB;
    await assert.rejects(verifyDataKeyBinding(db), { code: 'DATA_KEY_MISMATCH' });
    await assert.rejects(db.execute("UPDATE data_key_binding SET fingerprint='x'"));
    await assert.rejects(db.execute('DELETE FROM data_key_binding'));
  } finally {
    process.env.HR_DATA_KEY = keyA;
    await db.close();
  }
  // Existing database without a binding (deployed before this fix): proven by decryption.
  const legacy = await createDatabase(':memory:');
  try {
    process.env.HR_DATA_KEY = keyB;
    await assert.rejects(verifyDataKeyBinding(legacy), { code: 'DATA_KEY_MISMATCH' });
    assert.equal(
      (await legacy.read<{ n: number }>('SELECT count(*) AS n FROM data_key_binding'))[0].n,
      0,
      'a wrong key is never recorded',
    );
    process.env.HR_DATA_KEY = keyA;
    assert.equal(await verifyDataKeyBinding(legacy), 'bound');
  } finally {
    process.env.HR_DATA_KEY = keyA;
    await legacy.close();
  }
});

test('a legacy binding checks every encrypted record kind, not only profiles and files', async () => {
  const { verifyDataKeyBinding } = await import('../../server/data-key.js');
  const { encryptSensitive } = await import('../../server/administration/security.js');
  process.env.HR_DATA_KEY = keyA;
  const db = await createDatabase(':memory:');
  try {
    // Only an attendance note holds encrypted data (reproduces the PR #3 review case).
    await db.execute("UPDATE employee_profile_data SET encrypted_values_json='{}'");
    const id = 'att-legacy-1';
    const now = new Date().toISOString();
    await db.execute(
      `INSERT INTO attendance_records(id,employee_id,work_date,check_in,check_out,minutes,work_mode,encrypted_note,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?)`,
      [
        id,
        'emp-omar',
        '2026-11-01',
        '08:00',
        '16:00',
        480,
        'office',
        encryptSensitive('ملاحظة', `attendance:${id}:note`),
        now,
        now,
      ],
    );
    process.env.HR_DATA_KEY = keyB;
    await assert.rejects(verifyDataKeyBinding(db), { code: 'DATA_KEY_MISMATCH' });
    assert.equal(
      (await db.read<{ n: number }>('SELECT count(*) AS n FROM data_key_binding'))[0].n,
      0,
    );
    process.env.HR_DATA_KEY = keyA;
    assert.equal(await verifyDataKeyBinding(db), 'bound');
  } finally {
    process.env.HR_DATA_KEY = keyA;
    await db.close();
  }
});

test('a legacy binding also proves the key against encrypted finance records', async () => {
  const { verifyDataKeyBinding } = await import('../../server/data-key.js');
  const { encryptSensitive } = await import('../../server/administration/security.js');
  process.env.HR_DATA_KEY = keyA;
  const db = await createDatabase(':memory:');
  try {
    await db.execute("UPDATE employee_profile_data SET encrypted_values_json='{}'");
    const now = new Date().toISOString();
    await db.execute(
      'INSERT INTO finance_customers(id,owner_id,version,customer_ciphertext,created_at,updated_at) VALUES(?,?,1,?,?,?)',
      [
        'cust-1',
        'emp-omar',
        encryptSensitive('{"name":"عميل وهمي"}', 'finance:customer:cust-1'),
        now,
        now,
      ],
    );
    process.env.HR_DATA_KEY = keyB;
    await assert.rejects(verifyDataKeyBinding(db), { code: 'DATA_KEY_MISMATCH' });
    process.env.HR_DATA_KEY = keyA;
    assert.equal(await verifyDataKeyBinding(db), 'bound');
  } finally {
    process.env.HR_DATA_KEY = keyA;
    await db.close();
  }
  // Ledger records (migration 012) alone are enough to refuse a wrong key.
  const ledger = await createDatabase(':memory:');
  try {
    await ledger.execute("UPDATE employee_profile_data SET encrypted_values_json='{}'");
    const now = new Date().toISOString();
    await ledger.execute(
      'INSERT INTO finance_vendors(id,owner_id,version,vendor_ciphertext,created_at,updated_at) VALUES(?,?,1,?,?,?)',
      [
        'vendor-1',
        'emp-omar',
        encryptSensitive('{"name":"مورد وهمي"}', 'finance:vendor:vendor-1'),
        now,
        now,
      ],
    );
    process.env.HR_DATA_KEY = keyB;
    await assert.rejects(verifyDataKeyBinding(ledger), { code: 'DATA_KEY_MISMATCH' });
    process.env.HR_DATA_KEY = keyA;
    assert.equal(await verifyDataKeyBinding(ledger), 'bound');
  } finally {
    process.env.HR_DATA_KEY = keyA;
    await ledger.close();
  }
});

// Note 9: applied migrations could be edited without anyone noticing.
test('an applied migration that changed on disk stops startup', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'hr-migration-checksum-'));
  const path = join(directory, 'checksum.sqlite');
  try {
    const first = await createDatabase(path);
    const rows = await first.read<{ version: number; checksum: string | null }>(
      'SELECT version,checksum FROM schema_migrations ORDER BY version',
    );
    assert.ok(rows.length >= 9 && rows.every((r) => /^[0-9a-f]{64}$/.test(r.checksum ?? '')));
    // Simulate a database migrated before checksums existed: baseline is recorded on open.
    await first.execute('UPDATE schema_migrations SET checksum=NULL WHERE version=5');
    await first.close();
    const second = await createDatabase(path);
    const [baseline] = await second.read<{ checksum: string | null }>(
      'SELECT checksum FROM schema_migrations WHERE version=5',
    );
    assert.equal(baseline.checksum, rows.find((r) => r.version === 5)!.checksum);
    // Simulate an edited 005 file: recorded checksum no longer matches the file.
    await second.execute('UPDATE schema_migrations SET checksum=? WHERE version=5', [
      '0'.repeat(64),
    ]);
    await second.close();
    await assert.rejects(
      createDatabase(path),
      /Migration 005_payroll changed after it was applied/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

// Note 11: hardening headers were added after the API routes, so API replies lacked them.
test('API responses carry the security headers; hosted origins also get HSTS', async () => {
  const db = await createDatabase(':memory:');
  const local = await listen(createApp(db));
  const hosted = await listen(createApp(db, { publicOrigin: 'https://preview.example.test' }));
  try {
    const res = await call(local.port, '/api/health', { headers: { host: '127.0.0.1' } });
    assert.equal(res.status, 200);
    assert.equal(res.headers['x-frame-options'], 'DENY');
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.equal(res.headers['referrer-policy'], 'same-origin');
    assert.match(String(res.headers['content-security-policy']), /default-src 'none'/);
    assert.equal(res.headers['strict-transport-security'], undefined);
    const denied = await call(local.port, '/api/session', { headers: { host: 'evil.test' } });
    assert.equal(denied.status, 403);
    assert.equal(denied.headers['x-frame-options'], 'DENY', 'errors carry them too');
    const remote = await call(hosted.port, '/api/health', {
      headers: { host: 'preview.example.test' },
    });
    assert.match(String(remote.headers['strict-transport-security']), /max-age=\d+/);
    assert.equal(remote.headers['x-robots-tag'], 'noindex, nofollow');
  } finally {
    await new Promise<void>((done) => local.server.close(() => done()));
    await new Promise<void>((done) => hosted.server.close(() => done()));
    await db.close();
  }
});
