import { createServer } from 'node:http';
import { DatabaseSync, backup } from 'node:sqlite';
import { existsSync, mkdtempSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { createApp } from '../server/app.js';
import { createDatabase, createPostgresDatabase, type Db } from '../server/database.js';

if (existsSync('.env.pg-test')) process.loadEnvFile('.env.pg-test');
const command = promisify(execFile);
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
  'base64',
);
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const temp = mkdtempSync(join(tmpdir(), 'sabq-hr-recovery-'));
async function withApi<T>(
  db: Db,
  work: (call: (path: string, method?: string, body?: unknown) => Promise<Response>) => Promise<T>,
) {
  const server = createServer(createApp(db));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const login = await fetch(`${origin}/api/demo/session`, {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify({ employeeId: 'emp-noura' }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie')!.split(';')[0];
  const call = (path: string, method = 'GET', body?: unknown) =>
    fetch(`${origin}/api${path}`, {
      method,
      headers: {
        origin,
        cookie,
        'content-type': 'application/json',
        'idempotency-key': randomUUID(),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  try {
    return await work(call);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
async function populate(db: Db) {
  return withApi(db, async (call) => {
    const file = (await (await call('/admin/employees/emp-sara')).json()).file;
    const saved = await call('/admin/employees/emp-sara', 'PATCH', {
      version: file.version,
      reason: 'اختبار استرجاع اصطناعي',
      values: { mobile: '0500000123', basicSalary: 12345.67, title: 'محررة اختبار الاسترجاع' },
    });
    assert.equal(saved.status, 200, await saved.clone().text());
    const uploaded = await call('/admin/employees/emp-sara/documents', 'POST', {
      category: 'identity',
      filename: 'synthetic-recovery.png',
      mimeType: 'image/png',
      contentBase64: png.toString('base64'),
      expiresAt: '2027-12-31',
    });
    assert.equal(uploaded.status, 201, await uploaded.clone().text());
    return (await uploaded.json()).document.id as string;
  });
}
async function verify(db: Db, id: string) {
  await withApi(db, async (call) => {
    const file = (await (await call('/admin/employees/emp-sara')).json()).file;
    assert.equal(file.values.mobile, '0500000123');
    assert.equal(file.values.basicSalary, 12345.67);
    assert.equal(file.employee.title, 'محررة اختبار الاسترجاع');
    assert.ok(file.documents.some((d: { id: string }) => d.id === id));
    const download = await call(`/admin/documents/${id}/download`);
    assert.equal(download.status, 200);
    assert.equal(digest(Buffer.from(await download.arrayBuffer())), digest(png));
    const raw = (
      await db.read<{ encrypted_values_json: string }>(
        'SELECT encrypted_values_json FROM employee_profile_data WHERE employee_id=?',
        ['emp-sara'],
      )
    )[0].encrypted_values_json;
    assert.ok(!raw.includes('0500000123') && !raw.includes('12345.67'));
  });
}
try {
  const original = join(temp, 'original.sqlite');
  const backupPath = join(temp, 'restored.sqlite');
  const first = await createDatabase(original);
  let docId: string;
  try {
    docId = await populate(first);
  } finally {
    await first.close();
  }
  const connection = new DatabaseSync(original, { readOnly: true });
  try {
    await backup(connection, backupPath);
  } finally {
    connection.close();
  }
  chmodSync(backupPath, 0o600);
  const restored = await createDatabase(backupPath);
  try {
    await verify(restored, docId!);
  } finally {
    await restored.close();
  }
  process.stdout.write(
    'SQLite backup/reopen: employee fields and encrypted private document verified.\n',
  );

  const value = process.env.HR_TEST_DATABASE_URL;
  if (!value)
    throw new Error('HR_TEST_DATABASE_URL is required for full PostgreSQL recovery verification.');
  const url = new URL(value);
  if (!['127.0.0.1', 'localhost'].includes(url.hostname))
    throw new Error('Recovery verification only operates on an isolated LOCAL PostgreSQL cluster.');
  const suffix = randomBytes(8).toString('hex');
  const schema = `hr_test_recovery_${suffix}`;
  const cloneName = `hr_restore_${suffix}`;
  const admin = new Pool({ connectionString: value, max: 2 });
  let db: Db | undefined;
  let clone: Db | undefined;
  let cloneCreated = false;
  const env = {
    ...process.env,
    PGHOST: url.hostname,
    PGPORT: url.port || '5432',
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
    PGDATABASE: url.pathname.slice(1),
  };
  try {
    db = await createPostgresDatabase(value, schema);
    const pgDoc = await populate(db);
    await db.close();
    db = undefined;
    db = await createPostgresDatabase(value, schema);
    await verify(db, pgDoc);
    const archive = join(temp, 'postgres.dump');
    await command(
      'pg_dump',
      [
        '--format=custom',
        '--no-owner',
        '--no-privileges',
        `--schema=${schema}`,
        `--file=${archive}`,
      ],
      { env, maxBuffer: 1024 * 1024 },
    );
    chmodSync(archive, 0o600);
    await admin.query(`CREATE DATABASE "${cloneName}"`);
    cloneCreated = true;
    await command(
      'pg_restore',
      ['--no-owner', '--no-privileges', `--dbname=${cloneName}`, archive],
      { env, maxBuffer: 1024 * 1024 },
    );
    const cloneUrl = new URL(value);
    cloneUrl.pathname = `/${cloneName}`;
    clone = await createPostgresDatabase(cloneUrl.toString(), schema);
    await verify(clone, pgDoc);
    process.stdout.write(
      'PostgreSQL pg_dump/pg_restore: restored isolated database, fields and encrypted document verified.\n',
    );
  } finally {
    await clone?.close();
    if (db) {
      await db.execute(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await db.close();
    } else await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    if (cloneCreated) await admin.query(`DROP DATABASE IF EXISTS "${cloneName}" WITH (FORCE)`);
    await admin.end();
  }
} finally {
  rmSync(temp, { recursive: true, force: true });
}
