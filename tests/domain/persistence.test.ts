import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { createApp } from '../../server/app.js';
import { createDatabase, createPostgresDatabase } from '../../server/database.js';

if (existsSync('.env.pg-test')) process.loadEnvFile('.env.pg-test');
const pgUrl = process.env.HR_TEST_DATABASE_URL;

test('SQLite adapter awaits transactions, rolls back, and reopens migrations', async () => {
  const first = await createDatabase();
  try {
    assert.equal(first.dialect, 'sqlite');
    await assert.rejects(
      first.transaction(async (tx) => {
        await tx.execute(
          "INSERT INTO audit_events(actor_id,actor_role,action,resource_id,created_at) VALUES('emp-sara','employee','rollback-test','x',?)",
          [new Date().toISOString()],
        );
        throw new Error('rollback sentinel');
      }),
      /rollback sentinel/,
    );
    assert.equal(
      (
        await first.read<{ n: number }>(
          "SELECT count(*) AS n FROM audit_events WHERE action='rollback-test'",
        )
      )[0].n,
      0,
    );
    assert.equal(
      (await first.read<{ n: number }>('SELECT count(*) AS n FROM schema_migrations'))[0].n,
      8,
    );
  } finally {
    await first.close();
  }
});

test(
  'PostgreSQL adapter migrates isolated schema and serves the same leave API',
  { skip: !pgUrl },
  async () => {
    const schema = `hr_preview_${randomBytes(16).toString('hex')}`;
    const db = await createPostgresDatabase(pgUrl!, schema);
    const server = createServer(createApp(db));
    try {
      assert.equal(db.dialect, 'postgres');
      assert.deepEqual(
        (
          await db.read<{ version: number }>(
            'SELECT version FROM schema_migrations ORDER BY version',
          )
        ).map((row) => row.version),
        [1, 2, 3, 4, 5, 6, 7, 8],
      );
      const roles = await db.read<{ id: string; role: string }>(
        "SELECT id,role FROM employee_access WHERE id IN ('emp-reem','emp-abdullah','emp-hind') ORDER BY id",
      );
      assert.deepEqual(
        roles.map((row) => row.role),
        ['approver', 'auditor', 'finance'],
      );

      await assert.rejects(
        db.transaction(async (tx) => {
          await tx.execute(
            "INSERT INTO audit_events(actor_id,actor_role,action,resource_id,created_at) VALUES('emp-sara','employee','rollback-test','x',?)",
            [new Date().toISOString()],
          );
          throw new Error('rollback sentinel');
        }),
        /rollback sentinel/,
      );
      assert.equal(
        (
          await db.read<{ n: string }>(
            "SELECT count(*)::text AS n FROM audit_events WHERE action='rollback-test'",
          )
        )[0].n,
        '0',
      );

      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      if (!address || typeof address === 'string')
        throw new Error('No PostgreSQL API test listener');
      const origin = `http://127.0.0.1:${address.port}`;
      const signed = await fetch(`${origin}/api/demo/session`, {
        method: 'POST',
        headers: { origin, 'content-type': 'application/json' },
        body: JSON.stringify({ employeeId: 'emp-sara' }),
      });
      assert.equal(signed.status, 200);
      const cookie = signed.headers.get('set-cookie')?.split(';')[0];
      assert.ok(cookie);
      const bootstrap = await fetch(`${origin}/api/bootstrap`, { headers: { cookie } });
      assert.equal(bootstrap.status, 200);
      const submitted = await fetch(`${origin}/api/leaves`, {
        method: 'POST',
        headers: {
          origin,
          cookie,
          'content-type': 'application/json',
          'idempotency-key': 'pg-test-leave',
        },
        body: JSON.stringify({
          startDate: '2027-02-07',
          endDate: '2027-02-08',
          note: 'PG adapter test',
        }),
      });
      assert.equal(submitted.status, 201, await submitted.text());
      assert.equal(
        (
          await db.read<{ n: string }>(
            "SELECT count(*)::text AS n FROM leave_ledger WHERE employee_id='emp-sara' AND kind='reserve'",
          )
        )[0].n,
        '2',
      );
    } finally {
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
      await db.close();
    }
  },
);

test(
  'PostgreSQL private seed=false migrations add no synthetic policies or fixtures',
  { skip: !pgUrl },
  async () => {
    const schema = `hr_preview_${randomBytes(16).toString('hex')}`;
    const db = await createPostgresDatabase(pgUrl!, schema, { seed: false });
    try {
      for (const table of [
        'employees',
        'policy_versions',
        'work_schedules',
        'employment_periods',
        'leave_requests',
        'leave_ledger',
        'administrative_requests',
        'payroll_runs',
        'administrative_policies',
      ]) {
        assert.equal(
          (await db.read<{ n: string }>(`SELECT COUNT(*)::text AS n FROM ${table}`))[0].n,
          '0',
          `private schema should have no synthetic rows in ${table}`,
        );
      }
    } finally {
      await db.close();
    }
  },
);

test('policy migration preserves the old flat calculator and creates a distinct profile-component version', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const directory = mkdtempSync(join(tmpdir(), 'hr-policy-upgrade-'));
  const path = join(directory, 'preview.sqlite');
  const legacy = '{"currency":"SAR","baseSalaryMinor":1000000,"calculation":"synthetic-flat-demo"}';
  try {
    const old = await createDatabase(path);
    await old.transaction(async (tx) => {
      // Reconstruct the unpublished intermediate local v6 fixture.
      await tx.execute('DELETE FROM schema_migrations WHERE version=7');
      await tx.execute("DELETE FROM administrative_policies WHERE id='payroll-policy-demo-v2'");
      await tx.execute(
        "UPDATE administrative_policies SET values_json=? WHERE id='payroll-policy-demo-v1'",
        [legacy],
      );
    });
    await old.close();
    const upgraded = await createDatabase(path);
    try {
      const policies = await upgraded.read<{ id: string; state: string; values_json: string }>(
        "SELECT id,state,values_json FROM administrative_policies WHERE policy_key='payroll-demo' ORDER BY version",
      );
      assert.equal(policies.length, 2);
      assert.equal(policies[0].values_json, legacy);
      assert.equal(policies[0].state, 'retired');
      assert.equal(policies[1].id, 'payroll-policy-demo-v2');
      assert.equal(policies[1].state, 'synthetic_approved');
      assert.equal(JSON.parse(policies[1].values_json).calculation, 'synthetic-profile-components');
    } finally {
      await upgraded.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
