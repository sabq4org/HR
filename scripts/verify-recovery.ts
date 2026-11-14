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
import { generate } from 'otplib';
import { createApp } from '../server/app.js';
import { createDatabase, createPostgresDatabase, type Db } from '../server/database.js';
import { provisionEmployeeAccount } from '../server/access/index.js';
import { decryptSensitive } from '../server/administration/security.js';
import { runMaintenance } from '../server/operations/index.js';

if (existsSync('.env.pg-test')) process.loadEnvFile('.env.pg-test');
const command = promisify(execFile);
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
  'base64',
);
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const accountPassword = 'Synthetic-Recovery-Account-2026!';
type AccountRecoveryFixture = {
  employeeId: string;
  loginName: string;
  recoveryCode: string;
  encryptedTotp: string;
  totpSecret: string;
};
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
async function verifyOperationsState(db: Db, runId: string) {
  const run = (
    await db.read<{ status: string; failure_code: string | null }>(
      'SELECT status,failure_code FROM operations_job_runs WHERE id=?',
      [runId],
    )
  )[0];
  assert.equal(run?.status, 'succeeded', 'Maintenance run state did not survive recovery');
  assert.equal(run.failure_code, null, 'Successful maintenance run contains a failure code');
}
async function withAccountApi<T>(
  db: Db,
  work: (call: (path: string, body?: unknown, cookie?: string) => Promise<Response>) => Promise<T>,
): Promise<T> {
  const server = createServer(createApp(db, { authMode: 'accounts' }));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    return await work((path, body, cookie = '') =>
      fetch(`${origin}/api${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          origin,
          cookie,
          'content-type': 'application/json',
          'idempotency-key': randomUUID(),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
async function provisionAndActivateAccount(db: Db): Promise<AccountRecoveryFixture> {
  const employeeId = 'emp-sara';
  const loginName = 'synthetic-recovery@example.test';
  const activation = await provisionEmployeeAccount(db, { employeeId, loginName });
  return withAccountApi(db, async (call) => {
    const setupResponse = await call('/auth/activation/setup', {
      token: activation.activationToken,
    });
    assert.equal(setupResponse.status, 200, await setupResponse.clone().text());
    const setup = (await setupResponse.json()) as { secret: string };
    const completed = await call('/auth/activation/complete', {
      token: activation.activationToken,
      password: accountPassword,
      otp: await generate({ secret: setup.secret, epoch: Date.now() / 1000 }),
    });
    assert.equal(completed.status, 200, await completed.clone().text());
    const activationResult = (await completed.json()) as { recoveryCodes: string[] };
    const account = (
      await db.read<{ totp_secret_ciphertext: string }>(
        'SELECT totp_secret_ciphertext FROM employee_accounts WHERE employee_id=?',
        [employeeId],
      )
    )[0];
    assert.ok(account?.totp_secret_ciphertext);
    assert.equal(
      decryptSensitive(account.totp_secret_ciphertext, `employee-account:${employeeId}:totp:v1`),
      setup.secret,
    );
    return {
      employeeId,
      loginName,
      recoveryCode: activationResult.recoveryCodes[0],
      encryptedTotp: account.totp_secret_ciphertext,
      totpSecret: setup.secret,
    };
  });
}
async function verifyAccountRecovery(db: Db, fixture: AccountRecoveryFixture) {
  const account = (
    await db.read<{ totp_secret_ciphertext: string }>(
      'SELECT totp_secret_ciphertext FROM employee_accounts WHERE employee_id=?',
      [fixture.employeeId],
    )
  )[0];
  assert.equal(account?.totp_secret_ciphertext, fixture.encryptedTotp);
  assert.equal(
    decryptSensitive(
      account.totp_secret_ciphertext,
      `employee-account:${fixture.employeeId}:totp:v1`,
    ),
    fixture.totpSecret,
  );
  await withAccountApi(db, async (call) => {
    const logged = await call('/auth/login', {
      loginName: fixture.loginName,
      password: accountPassword,
      otp: fixture.recoveryCode,
    });
    assert.equal(logged.status, 200, await logged.clone().text());
    const cookie = logged.headers.get('set-cookie')?.split(';')[0];
    assert.ok(cookie);
    const session = await call('/auth/session', undefined, cookie);
    assert.equal(session.status, 200);
    assert.equal(((await session.json()) as { me: { id: string } }).me.id, fixture.employeeId);
    const replay = await call('/auth/login', {
      loginName: fixture.loginName,
      password: accountPassword,
      otp: fixture.recoveryCode,
    });
    assert.equal(
      replay.status,
      401,
      'a restored one-time recovery code must still be consumed once',
    );
  });
}
try {
  const original = join(temp, 'original.sqlite');
  const backupPath = join(temp, 'restored.sqlite');
  const first = await createDatabase(original);
  let docId: string;
  let sqliteMaintenanceRunId: string;
  let sqliteAccount: AccountRecoveryFixture;
  try {
    docId = await populate(first);
    sqliteAccount = await provisionAndActivateAccount(first);
    const maintenance = await runMaintenance(first);
    assert.equal(maintenance.status, 'succeeded');
    await verifyOperationsState(first, maintenance.runId);
    sqliteMaintenanceRunId = maintenance.runId;
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
    await verifyOperationsState(restored, sqliteMaintenanceRunId!);
    await verifyAccountRecovery(restored, sqliteAccount!);
  } finally {
    await restored.close();
  }
  process.stdout.write(
    'SQLite backup/reopen: employee fields, private document, maintenance state, and MFA recovery login verified.\n',
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
    const pgAccount = await provisionAndActivateAccount(db);
    const pgMaintenance = await runMaintenance(db);
    assert.equal(pgMaintenance.status, 'succeeded');
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
    await verifyOperationsState(clone, pgMaintenance.runId);
    await verifyAccountRecovery(clone, pgAccount);
    process.stdout.write(
      'PostgreSQL pg_dump/pg_restore: restored isolated database, private data, maintenance state, and MFA recovery login verified.\n',
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
